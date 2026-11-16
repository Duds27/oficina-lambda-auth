variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Região AWS."
}

variable "project" {
  type        = string
  default     = "oficina"
  description = "Prefixo de nomeação dos recursos."
}

variable "environment" {
  type        = string
  description = "Ambiente (homolog | prod)."
}

variable "state_bucket" {
  type        = string
  description = "Bucket S3 onde ficam os estados remotos dos repositórios de infra."
}

variable "jwt_secret_id" {
  type        = string
  description = "Nome/ID do secret (Secrets Manager) com a chave do JWT: {\"key\":\"...\"}. Use o nome (ex.: oficina/jwt), não o ARN — o Terraform resolve o ARN."
}

variable "jwt_issuer" {
  type    = string
  default = "OficinaMecanicaBackend"
}

variable "jwt_audience" {
  type    = string
  default = "OficinaMecanicaBackend"
}

variable "jwt_expires_minutes" {
  type    = number
  default = 60
}

variable "lambda_zip_path" {
  type        = string
  default     = "../dist/lambda.zip"
  description = "Pacote (zip) gerado pelo esbuild + zip no pipeline."
}

# ─────────────── os-service (endpoint interno de clientes) ───────────────
variable "os_service_url" {
  type        = string
  description = "URL base do os-service na rede privada (NLB interno), ex.: http://<dns-do-nlb-interno>. A Lambda chama {url}/internal/clientes/por-cpf/{cpf}."

  validation {
    condition     = can(regex("^https?://[^/]+", var.os_service_url))
    error_message = "os_service_url deve começar com http:// ou https://."
  }
}

variable "os_service_port" {
  type        = number
  default     = 80
  description = "Porta do listener do NLB interno (a mesma de os_service_url). Libera a saída da Lambda só para ela, dentro da VPC."
}

variable "os_service_timeout_ms" {
  type        = number
  default     = 3000
  description = "Tempo máximo de espera pela resposta do os-service. Passou disso, a Lambda responde 503."
}

variable "internal_key_secret_id" {
  type        = string
  description = "Nome/ID do secret com a chave do header X-Internal-Key: {\"key\":\"...\"}. O os-service lê o mesmo valor em InternalApi__Key."
}
