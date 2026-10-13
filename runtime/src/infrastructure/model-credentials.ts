import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {credentialValues, type ModelCredentials} from '../domain/credentials.js';

// Runtime-owned secret store. Registry, manifest, Core and exports contain references only.
export class FileModelCredentials implements ModelCredentials {
  private key: Buffer;
  private values: Record<string,string> = {};
  private file: string;
  constructor(directory: string, private environment: NodeJS.ProcessEnv = process.env) {
    mkdirSync(directory, {recursive:true, mode:0o700});
    this.file = join(directory, 'model-credentials.enc');
    const keyFile = join(directory, 'model-credentials.key');
    if (!existsSync(keyFile)) {
      if (existsSync(this.file)) throw new Error('Credential store key missing');
      writeFileSync(keyFile, randomBytes(32), {flag:'wx', mode:0o600});
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('Invalid credential store key');
    if (existsSync(this.file)) {
      try {
        const data = readFileSync(this.file);
        if (data.length < 29 || data.length > 100000) throw Error();
        const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0,12));
        cipher.setAuthTag(data.subarray(12,28));
        this.values = credentialValues(JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')),100);
      } catch { throw new Error('Credential store unreadable; preserve and restore its original key and data'); }
    }
  }
  get(reference: string) { return this.values[reference] ?? this.environment[reference]; }
  references() { return Object.keys(this.values); }
  save(value: Record<string,string>) {
    const next = {...this.values, ...credentialValues(value)};
    if (Object.keys(next).length > 100) throw new Error('Credential store limit reached');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    if (encrypted.length + 28 > 100000) throw new Error('Credential store byte limit reached');
    const temporary = this.file + '.' + randomBytes(12).toString('hex') + '.tmp';
    try {
      writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {flag:'wx', mode:0o600});
      renameSync(temporary, this.file);
      this.values = next;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
