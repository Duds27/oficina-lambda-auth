import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getConfig, type AppConfig, type JwtConfig } from "./config.js";
import { isValidCpfCnpj, normalize } from "./cpf.js";
import { issueToken, type ClienteClaims, type IssuedToken } from "./jwt.js";
import { findClienteByCpf, OsServiceUnavailableError, type ClienteRecord } from "./osService.js";

export interface AuthResult {
  status: number;
  body: Record<string, unknown>;
}

export interface AuthDeps {
  config: AppConfig;
  findCliente: (cpfNormalized: string) => Promise<ClienteRecord | null>;
  issue: (cfg: JwtConfig, claims: ClienteClaims) => IssuedToken;
}

/**
 * Núcleo da autenticação por CPF (puro/testável, sem dependência da AWS):
 *  1. valida o CPF (formato + dígitos verificadores);
 *  2. pergunta ao os-service se o cliente existe (endpoint interno, via HTTP);
 *  3. verifica o status (ativo);
 *  4. emite e devolve um JWT válido, com o claim `clienteId`.
 */
export async function authenticate(cpfRaw: string | undefined, deps: AuthDeps): Promise<AuthResult> {
  if (!isValidCpfCnpj(cpfRaw)) {
    return { status: 400, body: { error: "CPF inválido." } };
  }

  const cpf = normalize(cpfRaw!);

  let cliente: ClienteRecord | null;
  try {
    cliente = await deps.findCliente(cpf);
  } catch (err) {
    if (!(err instanceof OsServiceUnavailableError)) throw err;
    // A causa (timeout, 5xx, chave recusada...) fica no log; o cliente não precisa dela.
    console.error(`[auth] ${err.message}`);
    return {
      status: 503,
      body: { error: "Serviço de clientes indisponível. Tente novamente em instantes." },
    };
  }

  if (!cliente) {
    return { status: 401, body: { error: "Cliente não encontrado." } };
  }
  if (!cliente.ativo) {
    return { status: 403, body: { error: "Cliente inativo." } };
  }

  const token = deps.issue(deps.config.jwt, {
    clienteId: cliente.id,
    cpf,
    nome: cliente.nome,
  });

  return { status: 200, body: { token: token.token, expiresAt: token.expiresAt } };
}

/** Adaptador AWS Lambda (API Gateway HTTP API v2). */
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const config = await getConfig();

  let cpf: string | undefined;
  try {
    const parsed = event.body ? JSON.parse(event.body) : {};
    cpf = parsed.cpf;
  } catch {
    return json(400, { error: "Corpo da requisição inválido (JSON esperado)." });
  }

  const result = await authenticate(cpf, {
    config,
    findCliente: (c) => findClienteByCpf(config.osService, c),
    issue: issueToken,
  });

  return json(result.status, result.body);
};

function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
