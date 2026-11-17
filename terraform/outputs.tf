output "api_endpoint" {
  description = "URL base do API Gateway (POST /auth, /api/* e o webhook)."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "auth_function_name" {
  value = aws_lambda_function.auth.function_name
}

output "authorizer_function_name" {
  value = aws_lambda_function.authorizer.function_name
}

output "webhook_mercadopago_url" {
  description = "URL pública do webhook: Pagamentos__MercadoPago__NotificationUrl do billing-service."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/webhooks/mercadopago"
}

output "os_service_url" {
  description = "URL do os-service que a Lambda usa."
  value       = local.os_service_url
}

output "rotas" {
  description = "Rota → serviço (as públicas não exigem JWT)."
  value = {
    protegidas = local.rotas_protegidas
    publicas   = local.rotas_publicas
  }
}
