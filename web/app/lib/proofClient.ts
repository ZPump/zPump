export interface ProofResponse {
  proof: string;
  publicInputs: string[];
  verifyingKeyHash: string;
}

interface ProofClientOptions {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_PROOF_RPC_URL ?? 'http://localhost:8788';

export class ProofClient {
  private readonly baseUrl: string;

  constructor(options?: ProofClientOptions) {
    this.baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
  }

  async requestProof<TPayload extends Record<string, unknown>>(
    circuit: 'shield' | 'transfer' | 'unshield',
    payload: TPayload
  ): Promise<ProofResponse> {
    const response = await fetch(`${this.baseUrl}/prove/${circuit}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'unknown error' }));
      throw new Error(`Proof RPC error: ${error.message ?? response.statusText}`);
    }
    return (await response.json()) as ProofResponse;
  }
}
