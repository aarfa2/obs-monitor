import { networkInterfaces } from "node:os";

export function lanUrls(port: number): string[] {
  const urls = [`http://127.0.0.1:${port}`];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || addr.family !== "IPv4") continue;
      urls.push(`http://${addr.address}:${port}`);
    }
  }
  return urls;
}
