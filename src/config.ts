import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/**
 * Configuração das funções. Os segredos (chave do JWT e chave interna do os-service)
 * vêm do AWS Secrets Manager e ficam em cache entre invocações (reuso do container),
 * o que reduz latência e chamadas à API.
 *
 * O authorizer só precisa da parte do JWT (`getJwtConfig`). A função de autenticação
 * também precisa do endereço do os-service e da chave interna (`getConfig`).
 */

export interface JwtConfig {
  key: string;
  issuer: string;
  audience: string;
  expiresInMinutes: number;
}

export interface OsServiceConfig {
  /** URL base do os-service na rede privada (NLB interno), sem barra no final. */
  baseUrl: string;
  /** Valor do header `X-Internal-Key` (o mesmo de `InternalApi__Key` no os-service). */
  internalKey: string;
  /** Tempo máximo de espera pela resposta do os-service. */
  timeoutMs: number;
}

export interface AppConfig {
  jwt: JwtConfig;
  osService: OsServiceConfig;
}

/** Bem abaixo do timeout da Lambda (15 s): login lento é pior que um erro claro. */
export const DEFAULT_OS_SERVICE_TIMEOUT_MS = 3000;

let jwtCached: JwtConfig | undefined;
let appCached: AppConfig | undefined;

const sm = new SecretsManagerClient({});

async function readSecretJson(secretId: string): Promise<Record<string, unknown>> {
  const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!out.SecretString) throw new Error(`Secret ${secretId} sem SecretString.`);
  return JSON.parse(out.SecretString);
}

export async function getJwtConfig(): Promise<JwtConfig> {
  if (jwtCached) return jwtCached;

  const jwtSecretId = requireEnv("JWT_SECRET_ID");
  const jwtSecret = await readSecretJson(jwtSecretId);

  jwtCached = {
    key: requireSecretField(jwtSecret, "key", jwtSecretId),
    issuer: process.env.JWT_ISSUER ?? "OficinaMecanicaBackend",
    audience: process.env.JWT_AUDIENCE ?? "OficinaMecanicaBackend",
    expiresInMinutes: Number(process.env.JWT_EXPIRES_MINUTES ?? "60"),
  };
  return jwtCached;
}

export async function getConfig(): Promise<AppConfig> {
  if (appCached) return appCached;

  // Lidas antes de chamar a AWS, para a falta de uma variável aparecer logo no log.
  const baseUrl = requireEnv("OS_SERVICE_URL").replace(/\/+$/, "");
  const internalKeySecretId = requireEnv("INTERNAL_KEY_SECRET_ID");
  const timeoutMs = parseTimeout(process.env.OS_SERVICE_TIMEOUT_MS);

  const [jwt, internalKeySecret] = await Promise.all([
    getJwtConfig(),
    readSecretJson(internalKeySecretId),
  ]);

  appCached = {
    jwt,
    osService: {
      baseUrl,
      internalKey: requireSecretField(internalKeySecret, "key", internalKeySecretId),
      timeoutMs,
    },
  };
  return appCached;
}

/** Permite injetar config nos testes (ignora o Secrets Manager). */
export function __setConfigForTests(cfg: AppConfig | undefined): void {
  appCached = cfg;
  jwtCached = cfg?.jwt;
}

function parseTimeout(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OS_SERVICE_TIMEOUT_MS;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

function requireSecretField(secret: Record<string, unknown>, field: string, secretId: string): string {
  const v = secret[field];
  if (typeof v !== "string" || !v) {
    throw new Error(`Secret ${secretId} sem o campo "${field}" (formato esperado: {"${field}":"..."}).`);
  }
  return v;
}
