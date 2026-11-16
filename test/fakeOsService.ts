import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * os-service falso: um servidor HTTP local de verdade, para os testes exercitarem o
 * `fetch` real (headers, status, corpo e timeout) sem depender do serviço .NET.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export type Responder = (res: ServerResponse) => void;

export interface FakeOsService {
  baseUrl: string;
  requests: RecordedRequest[];
  respondWith(responder: Responder): void;
  close(): Promise<void>;
}

export async function startFakeOsService(): Promise<FakeOsService> {
  let responder: Responder = json(500, { error: "responder não configurado" });
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    responder(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    respondWith(r) {
      responder = r;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(status: number, body: unknown): Responder {
  return (res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

/** Aceita a conexão e nunca responde. */
export const never: Responder = () => {};

/** Manda os headers e parte do corpo, e para. */
export const stallBody: Responder = (res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.write('{"id":7,');
};
