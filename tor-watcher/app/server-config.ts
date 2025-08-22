'use server';

export type PublicConfig = {
  VOD_API_URL: string;
};

export async function getPublicConfig(): Promise<PublicConfig> {
  return {
    VOD_API_URL: process.env.VOD_API_URL || "http://localhost:4001",
  }
}