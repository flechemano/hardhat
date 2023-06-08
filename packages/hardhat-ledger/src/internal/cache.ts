import fs from "fs-extra";
import path from "path";

type CacheableJson = Record<string, string>;

const CACHE_FILE_NAME = "accounts.json";

export async function write<T extends CacheableJson>(json: T) {
  const ledgerCacheFile = await getLedgerCacheFile();
  await fs.writeJSON(ledgerCacheFile, json);
}

export async function read<T>(): Promise<T | undefined> {
  const ledgerCacheFile = await getLedgerCacheFile();
  try {
    await fs.access(ledgerCacheFile, fs.constants.F_OK);
    const file = await fs.readJSON(ledgerCacheFile);
    return file;
  } catch (error) {}
}

async function getLedgerCacheFile(fileName = CACHE_FILE_NAME) {
  const ledgerCacheDir = await getLedgerCacheDir();
  return path.join(ledgerCacheDir, fileName);
}

async function getLedgerCacheDir() {
  const cache = await getCacheDir();
  const compilersCache = path.join(cache, "ledger");
  await fs.ensureDir(compilersCache);
  return compilersCache;
}

async function getCacheDir(): Promise<string> {
  const { cache } = await generatePaths();
  await fs.ensureDir(cache);
  return cache;
}

async function generatePaths(packageName = "hardhat") {
  const { default: envPaths } = await import("env-paths");
  return envPaths(packageName);
}
