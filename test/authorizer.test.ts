import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { handler } from "../src/authorizer.js";
import { __setConfigForTests, type AppConfig } from "../src/config.js";
import { issueToken } from "../src/jwt.js";

const config: AppConfig = {
  jwt: {
    key: "chave-de-teste-hs256-com-32-bytes-min!!",
    issuer: "OficinaMecanicaBackend",
    audience: "OficinaMecanicaBackend",
    expiresInMinutes: 60,
  },
  osService: { baseUrl: "http://os-service.invalid", internalKey: "k", timeoutMs: 1000 },
};

function evento(authorization?: string): APIGatewayRequestAuthorizerEventV2 {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as APIGatewayRequestAuthorizerEventV2;
}

beforeAll(() => __setConfigForTests(config));
afterAll(() => __setConfigForTests(undefined));

describe("authorizer", () => {
  it("autoriza token válido e repassa clienteId e cpf no contexto", async () => {
    const { token } = issueToken(config.jwt, { clienteId: 7, cpf: "52998224725", nome: "Maria" });

    const res = await handler(evento(`Bearer ${token}`));

    expect(res.isAuthorized).toBe(true);
    expect(res.context).toEqual({ clienteId: "7", cpf: "52998224725" });
  });

  it("usa o sub em tokens emitidos antes do claim clienteId", async () => {
    const legado = jwt.sign({ cpf: "52998224725" }, config.jwt.key, {
      algorithm: "HS256",
      subject: "9",
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      expiresIn: 60,
    });

    const res = await handler(evento(`Bearer ${legado}`));

    expect(res.isAuthorized).toBe(true);
    expect(res.context.clienteId).toBe("9");
  });

  it("nega quando não há token", async () => {
    expect((await handler(evento())).isAuthorized).toBe(false);
    expect((await handler(evento("Bearer "))).isAuthorized).toBe(false);
  });

  it("nega token assinado com outra chave", async () => {
    const { token } = issueToken(
      { ...config.jwt, key: "outra-chave-qualquer-com-32-bytes-min!!" },
      { clienteId: 7, cpf: "52998224725", nome: "Maria" }
    );
    expect((await handler(evento(`Bearer ${token}`))).isAuthorized).toBe(false);
  });
});
