import { Buffer } from 'buffer';

/**
 * IPFS Service Module
 * Handles uploading metadata and images to IPFS for native zToken minting
 */

const IPFS_GATEWAY_URL = process.env.NEXT_PUBLIC_IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs';
const IPFS_PROXY_ENDPOINT = '/api/ipfs/add';

export interface TokenMetadata {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  external_url?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
  properties?: {
    files?: Array<{ uri: string; type: string }>;
  };
}

/**
 * Upload data to IPFS and return the CID
 */
function toBase64Payload(data: ArrayBuffer | Buffer | string): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }
  return data;
}

export async function uploadToIPFS(
  data: Buffer | ArrayBuffer | string,
  contentType?: string,
  filename?: string
): Promise<string> {
  try {
    const buffer = toBase64Payload(data);
    const response = await fetch(IPFS_PROXY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: buffer.toString('base64'),
        contentType: contentType ?? 'application/octet-stream',
        filename: filename ?? 'upload.bin',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`IPFS upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    const cid = result.Hash || result.IpfsHash || result.cid;
    if (!cid) {
      throw new Error('IPFS upload response missing CID');
    }
    return cid;
  } catch (error) {
    console.error('[IPFS] Upload failed:', error);
    throw error;
  }
}

/**
 * Upload token metadata JSON to IPFS
 */
export async function uploadMetadata(metadata: TokenMetadata): Promise<string> {
  const jsonString = JSON.stringify(metadata, null, 2);
  const filename = `${metadata.symbol ?? metadata.name ?? 'metadata'}.json`;
  return uploadToIPFS(jsonString, 'application/json', filename);
}

/**
 * Upload image file to IPFS
 */
export async function uploadImage(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const contentType = file.type || 'image/png';
  return uploadToIPFS(arrayBuffer, contentType, file.name || 'image');
}

/**
 * Get IPFS gateway URL for a CID
 */
export function getIPFSURL(cid: string): string {
  // Remove ipfs:// prefix if present
  const cleanCid = cid.replace(/^ipfs:\/\//, '');
  return `${IPFS_GATEWAY_URL}/${cleanCid}`;
}

/**
 * Create token metadata JSON following Metaplex standard
 */
export function createTokenMetadata(params: {
  name: string;
  symbol: string;
  description?: string;
  imageCid?: string;
  externalUrl?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
}): TokenMetadata {
  const metadata: TokenMetadata = {
    name: params.name,
    symbol: params.symbol,
  };

  if (params.description) {
    metadata.description = params.description;
  }

  if (params.imageCid) {
    metadata.image = `ipfs://${params.imageCid}`;
    metadata.properties = {
      files: [
        {
          uri: `ipfs://${params.imageCid}`,
          type: 'image/png', // Default, can be overridden
        },
      ],
    };
  }

  if (params.externalUrl) {
    metadata.external_url = params.externalUrl;
  }

  if (params.attributes && params.attributes.length > 0) {
    metadata.attributes = params.attributes;
  }

  return metadata;
}


