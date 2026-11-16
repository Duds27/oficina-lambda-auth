import jwt from "jsonwebtoken";
import type { JwtConfig } from "./config.js";

/**
 * Emissão e validação de JWT em HS256, compatível com a validação do app .NET
 * (mesmos issuer/audience/chave). A chave deve ser ASCII — o app .NET usa
 * Encoding.ASCII, e para chaves ASCII a assinatura HMAC coincide com a do
 * jsonwebtoken (UTF-8).
 */

export interface ClienteClaims {
  clienteId: number;
  cpf: string;
  nome: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: string; // ISO 8601
}

export function issueToken(cfg: JwtConfig, claims: ClienteClaims): IssuedToken {
  const expiresInSec = cfg.expiresInMinutes * 60;
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);

  const token = jwt.sign(
    {
      // Claims .NET (ClaimTypes.Name / Role) usam URIs longas; incluímos ambas as
      // formas para interoperabilidade com o pipeline de autorização do ASP.NET.
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": claims.nome,
      "http://schemas.microsoft.com/ws/2008/06/identity/claims/role": "Cliente",
      // O billing-service usa este claim para conferir que quem aprova o orçamento
      // é o dono dele. O `sub` continua com o mesmo valor, por compatibilidade.
      clienteId: claims.clienteId,
      cpf: claims.cpf,
      role: "Cliente",
      name: claims.nome,
    },
    cfg.key,
    {
      algorithm: "HS256",
      subject: String(claims.clienteId),
      issuer: cfg.issuer,
      audience: cfg.audience,
      expiresIn: expiresInSec,
    }
  );

  return { token, expiresAt: expiresAt.toISOString() };
}

export function verifyToken(cfg: JwtConfig, token: string): jwt.JwtPayload {
  const payload = jwt.verify(token, cfg.key, {
    algorithms: ["HS256"],
    issuer: cfg.issuer,
    audience: cfg.audience,
    clockTolerance: 0,
  });
  if (typeof payload === "string") throw new Error("Payload de token inválido.");
  return payload;
}
