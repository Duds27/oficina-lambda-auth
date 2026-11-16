import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { authenticate, handler, type AuthDeps } from "../src/handler.js";
import { issueToken, verifyToken } from "../src/jwt.js";
import { __setConfigForTests, type AppConfig } from "../src/config.js";
import { OsServiceUnavailableError, type ClienteRecord } from "../src/osService.js";
import { json, never, startFakeOsService, type FakeOsService } from "./fakeOsService.js";

const config: AppConfig = {
  jwt: {
    key: "chave-de-teste-hs256-com-32-bytes-min!!",
    issuer: "OficinaMecanicaBackend",
    audience: "OficinaMecanicaBackend",
    expiresInMinutes: 60,
  },
  osService: { baseUrl: "http://os-service.invalid", internalKey: "k", timeoutMs: 1000 },
};

const cliente: ClienteRecord = { id: 7, nome: "Maria Silva", ativo: true };

function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    config,
    findCliente: async () => cliente,
    issue: issueToken,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticate", () => {
  it("emite JWT válido para CPF de cliente ativo", async () => {
    const res = await authenticate("529.982.247-25", deps());
    expect(res.status).toBe(200);

    const token = res.body.token as string;
    expect(token).toBeTruthy();

    const payload = verifyToken(config.jwt, token) as Record<string, unknown>;
    expect(payload.sub).toBe("7");
    expect(payload.cpf).toBe("52998224725");
    expect(payload.role).toBe("Cliente");
    expect(payload.name).toBe("Maria Silva");
  });

  it("inclui o claim clienteId, usado pelo billing-service", async () => {
    const res = await authenticate("529.982.247-25", deps());
    const payload = verifyToken(config.jwt, res.body.token as string);
    expect(payload.clienteId).toBe(7);
  });

  it("consulta o os-service com o CPF sem máscara", async () => {
    const findCliente = vi.fn(async () => cliente);
    await authenticate("529.982.247-25", deps({ findCliente }));
    expect(findCliente).toHaveBeenCalledWith("52998224725");
  });

  it("rejeita CPF inválido com 400, sem chamar o os-service", async () => {
    const findCliente = vi.fn(async () => cliente);
    const res = await authenticate("111.111.111-11", deps({ findCliente }));
    expect(res.status).toBe(400);
    expect(findCliente).not.toHaveBeenCalled();
  });

  it("retorna 401 quando o cliente não existe", async () => {
    const res = await authenticate("529.982.247-25", deps({ findCliente: async () => null }));
    expect(res.status).toBe(401);
  });

  it("retorna 403 quando o cliente está inativo", async () => {
    const res = await authenticate(
      "529.982.247-25",
      deps({ findCliente: async () => ({ ...cliente, ativo: false }) })
    );
    expect(res.status).toBe(403);
  });

  it("retorna 503 e loga a causa quando o os-service está indisponível", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await authenticate(
      "529.982.247-25",
      deps({
        findCliente: async () => {
          throw new OsServiceUnavailableError("O os-service não respondeu em 3000 ms.");
        },
      })
    );

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/indisponível/);
    expect(res.body.error).not.toMatch(/3000/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("não respondeu em 3000 ms"));
  });

  it("deixa propagar erros que não são do os-service", async () => {
    await expect(
      authenticate(
        "529.982.247-25",
        deps({
          findCliente: async () => {
            throw new TypeError("bug");
          },
        })
      )
    ).rejects.toThrow("bug");
  });
});

describe("handler (Lambda + os-service falso)", () => {
  let os: FakeOsService;

  beforeAll(async () => {
    os = await startFakeOsService();
  });

  afterAll(async () => {
    __setConfigForTests(undefined);
    await os.close();
  });

  function usarOsService(timeoutMs = 1000): void {
    __setConfigForTests({
      ...config,
      osService: { baseUrl: os.baseUrl, internalKey: "chave-interna-de-teste", timeoutMs },
    });
  }

  async function invocar(body: string | undefined): Promise<APIGatewayProxyStructuredResultV2> {
    const event = { body } as unknown as APIGatewayProxyEventV2;
    return (await handler(event)) as APIGatewayProxyStructuredResultV2;
  }

  it("autentica pelo endpoint interno do os-service e devolve o token", async () => {
    usarOsService();
    os.respondWith(json(200, { id: 42, nome: "João", ativo: true }));
    const antes = os.requests.length;

    const res = await invocar(JSON.stringify({ cpf: "529.982.247-25" }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    const payload = verifyToken(config.jwt, body.token);
    expect(payload.clienteId).toBe(42);
    expect(payload.sub).toBe("42");
    expect(os.requests[antes]!.url).toBe("/internal/clientes/por-cpf/52998224725");
    expect(os.requests[antes]!.headers["x-internal-key"]).toBe("chave-interna-de-teste");
  });

  it("responde 503 quando o os-service não responde a tempo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    usarOsService(150);
    os.respondWith(never);

    const res = await invocar(JSON.stringify({ cpf: "529.982.247-25" }));

    expect(res.statusCode).toBe(503);
  });

  it("responde 400 para corpo que não é JSON", async () => {
    usarOsService();
    const res = await invocar("{cpf:");
    expect(res.statusCode).toBe(400);
  });
});
