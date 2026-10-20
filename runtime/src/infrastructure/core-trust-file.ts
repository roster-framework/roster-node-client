import {open} from "node:fs/promises";
import {validCoreTrustPolicy, type CoreTrustPolicy, type CoreTrustSource} from "../domain/core-trust.js";

export class FileCoreTrust implements CoreTrustSource {
  constructor(private readonly path: string) {}
  async current(): Promise<CoreTrustPolicy> {
    try {
      const file=await open(this.path,"r");
      try {
        const bytes=Buffer.alloc(65537);
        const {bytesRead}=await file.read(bytes,0,bytes.length,0);
        if(bytesRead>65536) throw new Error();
        const policy: unknown=JSON.parse(bytes.subarray(0,bytesRead).toString("utf8"));
        if(!validCoreTrustPolicy(policy)) throw new Error();
        return policy;
      } finally {await file.close();}
    } catch {throw new Error("Core trust policy unavailable");}
  }
}
