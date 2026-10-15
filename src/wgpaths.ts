/** Locations of the WireGuard for Windows binaries and our tunnel name. */
import { join } from "node:path";

export const WG_DIR = "C:\\Program Files\\WireGuard";
export const TUNNEL_DIR = join(WG_DIR, "Tunnel Configs");
export const TUNNEL_NAME = "gpn";
export const wgExe = (exe: string) => join(WG_DIR, exe);
