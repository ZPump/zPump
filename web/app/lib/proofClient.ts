export interface ProofResponse {
  proof: string;
  publicInputs: string[];
  verifyingKeyHash: string;
}

interface ProofClientOptions {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_PROOF_RPC_URL ?? '/api/proof';

const CIRCUIT_ALIAS = {
  wrap: 'shield',
  transfer: 'transfer',
  unwrap: 'unshield'
} as const;

type CircuitName = keyof typeof CIRCUIT_ALIAS;

export class ProofClient {
  private readonly baseUrl: string;

  constructor(options?: ProofClientOptions) {
    this.baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.info('[proof-client] using base URL', this.baseUrl);
    }
  }

  async requestProof<TPayload extends Record<string, unknown>>(
    circuit: CircuitName,
    payload: TPayload
  ): Promise<ProofResponse> {
    const resolvedCircuit = CIRCUIT_ALIAS[circuit];
    const url = `${this.baseUrl}/prove/${resolvedCircuit}`;
    if (typeof console !== 'undefined') {
      console.info('[proof-client] request', { url, circuit, payload });
    }
    const response = await fetch(`${this.baseUrl}/prove/${resolvedCircuit}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const json = await response.json();
        message = (json as { error?: string; message?: string }).message ?? message;
        console.warn('[proof-client] error response json', json);
      } catch {
        const text = await response.text().catch(() => '');
        if (text) {
          message = text;
          console.warn('[proof-client] error response text', text);
        }
      }
      throw new Error(`Proof RPC error: ${message}`);
    }
    const result = (await response.json()) as ProofResponse;
    console.info('[proof-client] success', { circuit, verifyingKeyHash: result.verifyingKeyHash });
    return result;
  }
}
