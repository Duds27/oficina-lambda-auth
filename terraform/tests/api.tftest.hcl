# Testes sem conta AWS: provider mockado e o estado do infra-k8s simulado.
# Rodar com: terraform -chdir=terraform init -backend=false && terraform -chdir=terraform test

# O provider AWS valida o formato dos ARNs e da policy que um recurso passa para outro.
mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/oficina-homolog-auth-lambda" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/apigw/oficina-homolog" }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-1:123456789012:function:oficina-homolog-auth"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:oficina-homolog-auth/invocations"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:us-east-1:123456789012:abc123"
      api_endpoint  = "https://abc123.execute-api.us-east-1.amazonaws.com"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:oficina-homolog/jwt-abc" }
  }
}

override_data {
  target = data.terraform_remote_state.k8s
  values = {
    outputs = {
      vpc_id                  = "vpc-123"
      vpc_cidr                = "10.20.0.0/16"
      private_subnet_ids      = ["subnet-a", "subnet-b"]
      nodes_security_group_id = "sg-nos-eks"
      nlb_dns_name            = "oficina-homolog-app-nlb.elb.us-east-1.amazonaws.com"
      listener_ports          = { os = 8081, billing = 8082, execution = 8083 }
      listener_arns = {
        os        = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/net/nlb/abc/os"
        billing   = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/net/nlb/abc/billing"
        execution = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/net/nlb/abc/execution"
      }
    }
  }
}

variables {
  environment            = "homolog"
  state_bucket           = "bucket-de-teste"
  jwt_secret_id          = "oficina-homolog/jwt"
  internal_key_secret_id = "oficina-homolog/internal-key"
  # Qualquer arquivo existente serve: o teste não publica o pacote.
  lambda_zip_path = "tests/api.tftest.hcl"
}

run "cada_recurso_vai_para_o_listener_do_seu_servico" {
  command = plan

  assert {
    condition = (
      aws_apigatewayv2_integration.servico["os"].integration_uri == "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/net/nlb/abc/os" &&
      aws_apigatewayv2_integration.servico["billing"].integration_uri == "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/net/nlb/abc/billing" &&
      aws_apigatewayv2_integration.servico["execution"].integration_uri == "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/net/nlb/abc/execution"
    )
    error_message = "Uma integração VPC Link por serviço, no listener dele."
  }

  assert {
    condition = (
      local.rotas_protegidas["ANY /api/ordens-servico/{proxy+}"] == "os" &&
      local.rotas_protegidas["ANY /api/orcamentos"] == "billing" &&
      local.rotas_protegidas["ANY /api/pagamentos/{proxy+}"] == "billing" &&
      local.rotas_protegidas["ANY /api/execucoes/{proxy+}"] == "execution"
    )
    error_message = "As rotas seguem a tabela da Etapa 4: recurso e {proxy+} para o serviço dono do caminho."
  }

  assert {
    condition     = length(aws_apigatewayv2_route.protegida) == 16
    error_message = "8 recursos × (raiz + {proxy+}) = 16 rotas protegidas."
  }
}

run "rotas_de_api_exigem_jwt" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_apigatewayv2_route.protegida : r.authorization_type == "CUSTOM"])
    error_message = "Todas as rotas /api/* (fora o login da equipe) passam pelo Lambda Authorizer."
  }

  assert {
    condition     = !contains(keys(local.rotas_protegidas), "ANY /api/{proxy+}")
    error_message = "A rota genérica da Fase 3 sai: cada recurso tem a sua."
  }
}

run "webhook_e_login_da_equipe_sao_publicos_com_throttling" {
  # apply: os route_settings têm campos calculados, desconhecidos no plan.
  command = apply

  assert {
    condition = (
      aws_apigatewayv2_route.publica["POST /webhooks/mercadopago"].authorization_type == "NONE" &&
      local.rotas_publicas["POST /webhooks/mercadopago"] == "billing" &&
      aws_apigatewayv2_route.publica["POST /api/auth/login"].authorization_type == "NONE" &&
      local.rotas_publicas["POST /api/auth/login"] == "os"
    )
    error_message = "Webhook (billing) e login da equipe (os) sem JWT."
  }

  assert {
    condition = (
      length(aws_apigatewayv2_stage.this.route_settings) == 2 &&
      alltrue([for s in aws_apigatewayv2_stage.this.route_settings : s.throttling_rate_limit == 10 && s.throttling_burst_limit == 20])
    )
    error_message = "As rotas públicas têm throttling próprio, menor que o padrão."
  }
}

run "internal_e_dev_nao_sao_roteados" {
  command = plan

  assert {
    condition = alltrue([
      for rota in concat(keys(local.rotas_protegidas), keys(local.rotas_publicas)) :
      !strcontains(rota, "/internal") && !strcontains(rota, "/dev")
    ])
    error_message = "/internal/* (chave interna da Lambda) e /dev/* (simulação de pagamento) ficam fora do API Gateway."
  }
}

run "lambda_chama_o_os_service_pelo_listener_dele" {
  command = plan

  assert {
    condition     = aws_lambda_function.auth.environment[0].variables["OS_SERVICE_URL"] == "http://oficina-homolog-app-nlb.elb.us-east-1.amazonaws.com:8081"
    error_message = "Sem os_service_url, a URL sai do DNS do NLB e da porta do listener do os-service."
  }

  assert {
    condition     = one([for e in aws_security_group.lambda.egress : e.from_port if e.description == "os-service pelo NLB interno"]) == 8081
    error_message = "O SG da Lambda libera só a porta do listener do os-service."
  }
}

run "os_service_url_explicita_prevalece" {
  command = plan

  variables {
    os_service_url  = "http://os-service.interno:9000"
    os_service_port = 9000
  }

  assert {
    condition     = aws_lambda_function.auth.environment[0].variables["OS_SERVICE_URL"] == "http://os-service.interno:9000"
    error_message = "A variável os_service_url, quando informada, vence a URL montada."
  }
}

run "os_service_url_vazia_usa_o_nlb" {
  command = plan

  # É o que o CD passa quando a variable OS_SERVICE_URL não existe no repositório.
  variables {
    os_service_url = ""
  }

  assert {
    condition     = output.os_service_url == "http://oficina-homolog-app-nlb.elb.us-east-1.amazonaws.com:8081"
    error_message = "String vazia conta como não informada."
  }
}

run "os_service_url_invalida" {
  command = plan

  variables {
    os_service_url = "os-service:8081"
  }

  expect_failures = [var.os_service_url]
}
