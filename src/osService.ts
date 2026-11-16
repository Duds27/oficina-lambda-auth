import type { OsServiceConfig } from "./config.js";

/**
 * Cliente HTTP do endpoint interno do os-service:
 * `GET {OS_SERVICE_URL}/internal/clientes/por-cpf/{cpf}` com o header `X-Internal-Key`.
 *
 * A Lambda não acessa banco: o cadastro de clientes pertence ao os-service, e só ele
 * lê a própria base. A rota interna fica fora do API Gateway público e é alcançada
 * pela rede privada da VPC (NLB interno).
 */

/** Corpo do 200 do endpoint interno (`ClienteInternoDto` no os-service). */
export interface ClienteRecord {
  id: number;
  nome: string;
  ativo: boolean;
}

/**
 * O os-service não respondeu, respondeu com erro ou com um corpo inesperado.
 * A mensagem diz a causa e vai só para o log; o cliente recebe um 503 genérico.
 */
export class OsServiceUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OsServiceUnavailableError";
  }
}

export type FetchFn = typeof fetch;

/** Busca o cliente pelo CPF/CNPJ já normalizado. `null` quando o os-service responde 404. */
export async function findClienteByCpf(
  cfg: OsServiceConfig,
  cpfNormalized: string,
  fetchFn: FetchFn = fetch
): Promise<ClienteRecord | null> {
  const url = `${cfg.baseUrl}/internal/clientes/por-cpf/${encodeURIComponent(cpfNormalized)}`;
  // O mesmo sinal cobre a conexão, os headers e a leitura do corpo.
  const signal = AbortSignal.timeout(cfg.timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { "X-Internal-Key": cfg.internalKey, Accept: "application/json" },
      signal,
    });
  } catch (err) {
    throw unavailable(err, cfg, "chamar o os-service");
  }

  if (response.status === 404) {
    await discardBody(response);
    return null;
  }
  if (response.status === 401) {
    await discardBody(response);
    throw new OsServiceUnavailableError(
      "O os-service recusou a chave interna (401). Confira se o secret de INTERNAL_KEY_SECRET_ID " +
        "tem o mesmo valor de InternalApi__Key no os-service."
    );
  }
  if (!response.ok) {
    await discardBody(response);
    throw new OsServiceUnavailableError(`O os-service respondeu ${response.status} em ${url}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw unavailable(err, cfg, "ler a resposta do os-service");
  }
  return toClienteRecord(body);
}

function toClienteRecord(body: unknown): ClienteRecord {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "number" || typeof b.nome !== "string" || typeof b.ativo !== "boolean") {
    throw new OsServiceUnavailableError(
      "Resposta inesperada do os-service: esperado { id: number, nome: string, ativo: boolean }."
    );
  }
  return { id: b.id, nome: b.nome, ativo: b.ativo };
}

function unavailable(err: unknown, cfg: OsServiceConfig, action: string): OsServiceUnavailableError {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new OsServiceUnavailableError(
      `O os-service não respondeu em ${cfg.timeoutMs} ms (${cfg.baseUrl}).`,
      { cause: err }
    );
  }
  const detail = err instanceof Error ? describeError(err) : String(err);
  return new OsServiceUnavailableError(`Falha ao ${action} (${cfg.baseUrl}): ${detail}`, {
    cause: err,
  });
}

/** O `fetch` do Node diz só "fetch failed"; a causa real (ECONNREFUSED, ENOTFOUND...) vem em `cause`. */
function describeError(err: Error): string {
  const cause = err.cause as { code?: string; message?: string } | undefined;
  if (cause?.code) return `${err.message} (${cause.code})`;
  if (cause?.message) return `${err.message} (${cause.message})`;
  return err.message;
}

/** Libera a conexão quando o corpo não interessa. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Sem efeito no resultado: a resposta já foi decidida pelo status.
  }
}
