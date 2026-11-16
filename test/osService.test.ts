import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OsServiceConfig } from "../src/config.js";
import { findClienteByCpf, OsServiceUnavailableError } from "../src/osService.js";
import { json, never, stallBody, startFakeOsService, type FakeOsService } from "./fakeOsService.js";

const CPF = "52998224725";
let os: FakeOsService;

function cfg(overrides: Partial<OsServiceConfig> = {}): OsServiceConfig {
  return { baseUrl: os.baseUrl, internalKey: "chave-interna-de-teste", timeoutMs: 2000, ...overrides };
}

beforeAll(async () => {
  os = await startFakeOsService();
});

afterAll(async () => {
  await os.close();
});

describe("findClienteByCpf", () => {
  it("chama o endpoint interno com X-Internal-Key e devolve o cliente", async () => {
    os.respondWith(json(200, { id: 7, nome: "Maria Silva", ativo: true }));
    const antes = os.requests.length;

    const cliente = await findClienteByCpf(cfg(), CPF);

    expect(cliente).toEqual({ id: 7, nome: "Maria Silva", ativo: true });
    const req = os.requests[antes]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`/internal/clientes/por-cpf/${CPF}`);
    expect(req.headers["x-internal-key"]).toBe("chave-interna-de-teste");
    expect(req.headers.accept).toBe("application/json");
  });

  it("devolve null quando o os-service responde 404", async () => {
    os.respondWith(json(404, { error: "Cliente não encontrado." }));
    await expect(findClienteByCpf(cfg(), CPF)).resolves.toBeNull();
  });

  it("explica a causa quando a chave interna é recusada (401)", async () => {
    os.respondWith((res) => {
      res.writeHead(401);
      res.end();
    });
    const erro = await findClienteByCpf(cfg(), CPF).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(OsServiceUnavailableError);
    expect((erro as Error).message).toMatch(/chave interna \(401\)/);
  });

  it("falha com o status quando o os-service responde 5xx", async () => {
    os.respondWith(json(500, { error: "boom" }));
    await expect(findClienteByCpf(cfg(), CPF)).rejects.toThrow(/respondeu 500/);
  });

  it("falha quando o corpo do 200 não tem o formato do contrato", async () => {
    os.respondWith(json(200, { Id: 7, Nome: "Maria" }));
    await expect(findClienteByCpf(cfg(), CPF)).rejects.toThrow(/Resposta inesperada/);
  });

  it("falha quando o corpo do 200 não é JSON", async () => {
    os.respondWith((res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>gateway</html>");
    });
    await expect(findClienteByCpf(cfg(), CPF)).rejects.toThrow(/ler a resposta do os-service/);
  });

  it("desiste no timeout quando o os-service não responde", async () => {
    os.respondWith(never);
    const inicio = Date.now();

    const erro = await findClienteByCpf(cfg({ timeoutMs: 150 }), CPF).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(OsServiceUnavailableError);
    expect((erro as Error).message).toMatch(/não respondeu em 150 ms/);
    expect(Date.now() - inicio).toBeLessThan(1500);
  });

  it("o timeout também vale para um corpo que para no meio", async () => {
    os.respondWith(stallBody);
    await expect(findClienteByCpf(cfg({ timeoutMs: 150 }), CPF)).rejects.toThrow(
      /não respondeu em 150 ms/
    );
  });

  it("mostra o código de rede quando não há ninguém escutando", async () => {
    const desligado = await startFakeOsService();
    await desligado.close();

    await expect(findClienteByCpf(cfg({ baseUrl: desligado.baseUrl }), CPF)).rejects.toThrow(
      /ECONNREFUSED/
    );
  });
});
