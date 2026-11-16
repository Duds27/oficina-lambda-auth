locals {
  name = "${var.project}-${var.environment}"
  k8s  = data.terraform_remote_state.k8s.outputs

  # Recurso → serviço. Os caminhos já são exclusivos de cada serviço, então o API Gateway
  # repassa o path como veio, sem reescrita. /internal/* e /dev/* ficam de fora de propósito.
  recursos = {
    "/api/clientes"       = "os"
    "/api/veiculos"       = "os"
    "/api/pecas"          = "os"
    "/api/servicos"       = "os"
    "/api/ordens-servico" = "os"
    "/api/orcamentos"     = "billing"
    "/api/pagamentos"     = "billing"
    "/api/execucoes"      = "execution"
  }

  # Rotas com JWT (Lambda Authorizer): o recurso e tudo abaixo dele.
  rotas_protegidas = merge(
    { for recurso, servico in local.recursos : "ANY ${recurso}" => servico },
    { for recurso, servico in local.recursos : "ANY ${recurso}/{proxy+}" => servico },
  )

  # Rotas sem JWT, com throttling próprio no stage.
  rotas_publicas = {
    # Mercado Pago: a assinatura x-signature é validada no billing-service.
    "POST /webhooks/mercadopago" = "billing"
    # Login da equipe (usuário e senha). O dos clientes, por CPF, é o POST /auth da Lambda.
    "POST /api/auth/login" = "os"
  }

  servicos = toset(values(merge(local.rotas_protegidas, local.rotas_publicas)))

  # Sem valor explícito, a Lambda chama o os-service pelo listener dele no NLB interno.
  os_service_port = coalesce(var.os_service_port, local.k8s.listener_ports["os"])
  os_service_url  = coalesce(var.os_service_url, "http://${local.k8s.nlb_dns_name}:${local.os_service_port}")
}

# ───────────── Estado remoto dos demais repositórios de infra ─────────────
# Repo 2 (infra-k8s): VPC, subnets privadas, SG dos nós e o NLB interno, com um listener
# por serviço (listener_arns, listener_ports, nlb_dns_name).
# A Lambda não depende mais do infra-database: o cliente vem do os-service, por HTTP.
data "terraform_remote_state" "k8s" {
  backend = "s3"
  config = {
    bucket = var.state_bucket
    key    = "infra-k8s/${var.environment}/terraform.tfstate"
    region = var.aws_region
  }
}

# ───────────────────────────── IAM da Lambda ─────────────────────────────
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name}-auth-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# Execução básica + ENI na VPC (necessário para alcançar o NLB interno do os-service).
resource "aws_iam_role_policy_attachment" "vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Resolve o ARN completo dos secrets a partir do nome/ID (IAM exige ARN em Resource).
data "aws_secretsmanager_secret" "jwt" {
  name = var.jwt_secret_id
}

data "aws_secretsmanager_secret" "internal_key" {
  name = var.internal_key_secret_id
}

# Só a chave do JWT e a chave interna do os-service. Nenhuma credencial de banco.
data "aws_iam_policy_document" "secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [data.aws_secretsmanager_secret.jwt.arn, data.aws_secretsmanager_secret.internal_key.arn]
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "${local.name}-auth-secrets"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.secrets.json
}

# ─────────────────────── Security group da Lambda ───────────────────────
resource "aws_security_group" "lambda" {
  name        = "${local.name}-auth-lambda-sg"
  description = "SG da Lambda de autenticacao"
  vpc_id      = data.terraform_remote_state.k8s.outputs.vpc_id

  # Saída restrita ao que a função usa. Sem regra para a porta 3306: a Lambda não fala
  # mais com o RDS. A regra de entrada do RDS (CIDR da VPC) fica no infra-database e
  # continua lá, porque também atende os nós do EKS.
  egress {
    description = "os-service pelo NLB interno"
    from_port   = local.os_service_port
    to_port     = local.os_service_port
    protocol    = "tcp"
    cidr_blocks = [data.terraform_remote_state.k8s.outputs.vpc_cidr]
  }

  egress {
    description = "Secrets Manager (HTTPS)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─────────────────────────── Funções Lambda ───────────────────────────
resource "aws_lambda_function" "auth" {
  function_name    = "${local.name}-auth"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "handler.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 15
  memory_size      = 256

  vpc_config {
    subnet_ids         = data.terraform_remote_state.k8s.outputs.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      JWT_SECRET_ID          = var.jwt_secret_id
      JWT_ISSUER             = var.jwt_issuer
      JWT_AUDIENCE           = var.jwt_audience
      JWT_EXPIRES_MINUTES    = tostring(var.jwt_expires_minutes)
      OS_SERVICE_URL         = local.os_service_url
      OS_SERVICE_TIMEOUT_MS  = tostring(var.os_service_timeout_ms)
      INTERNAL_KEY_SECRET_ID = var.internal_key_secret_id
    }
  }
}

resource "aws_lambda_function" "authorizer" {
  function_name    = "${local.name}-authorizer"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "authorizer.handler"
  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      JWT_SECRET_ID = var.jwt_secret_id
      JWT_ISSUER    = var.jwt_issuer
      JWT_AUDIENCE  = var.jwt_audience
    }
  }
}

# ───────────────────────── API Gateway (HTTP API) ─────────────────────────
resource "aws_apigatewayv2_api" "this" {
  name          = local.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.throttling_padrao.burst
    throttling_rate_limit  = var.throttling_padrao.rate
  }

  # As rotas sem JWT ganham um limite menor: são as que qualquer um alcança.
  dynamic "route_settings" {
    for_each = local.rotas_publicas
    content {
      route_key              = route_settings.key
      throttling_burst_limit = var.throttling_publico.burst
      throttling_rate_limit  = var.throttling_publico.rate
    }
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId     = "$context.requestId"
      ip            = "$context.identity.sourceIp"
      routeKey      = "$context.routeKey"
      status        = "$context.status"
      responseLat   = "$context.responseLatency"
      correlationId = "$context.requestId"
    })
  }

  # route_settings só aceita rotas que já existem.
  depends_on = [aws_apigatewayv2_route.publica]
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigw/${local.name}"
  retention_in_days = 14
}

# Integração da rota pública de autenticação → Lambda de auth.
resource "aws_apigatewayv2_integration" "auth" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.auth.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "auth" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /auth"
  target    = "integrations/${aws_apigatewayv2_integration.auth.id}"
}

resource "aws_lambda_permission" "auth" {
  statement_id  = "AllowAPIGatewayInvokeAuth"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# Lambda Authorizer (SIMPLE) para validar o JWT HS256 nas rotas /api/*.
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id                            = aws_apigatewayv2_api.this.id
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = aws_lambda_function.authorizer.invoke_arn
  identity_sources                  = ["$request.header.Authorization"]
  name                              = "${local.name}-jwt-authorizer"
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowAPIGatewayInvokeAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*"
}

# Integração privada (VPC Link → NLB interno do app no EKS).
resource "aws_apigatewayv2_vpc_link" "eks" {
  name               = "${local.name}-vpclink"
  subnet_ids         = data.terraform_remote_state.k8s.outputs.private_subnet_ids
  security_group_ids = [data.terraform_remote_state.k8s.outputs.nodes_security_group_id]
}

# Uma integração por serviço, cada uma no listener dele do NLB.
resource "aws_apigatewayv2_integration" "servico" {
  for_each = local.servicos

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = local.k8s.listener_arns[each.key]
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.eks.id
  payload_format_version = "1.0"
}

# Rotas protegidas: exigem JWT validado pelo Lambda Authorizer.
resource "aws_apigatewayv2_route" "protegida" {
  for_each = local.rotas_protegidas

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.servico[each.value].id}"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "publica" {
  for_each = local.rotas_publicas

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.servico[each.value].id}"
  authorization_type = "NONE"
}
