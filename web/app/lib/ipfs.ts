/**
 * IPFS Service Module
 * Handles uploading metadata and images to IPFS for native zToken minting
 */

const IPFS_API_URL = process.env.NEXT_PUBLIC_IPFS_API_URL || 'http://localhost:5001';
const IPFS_GATEWAY_URL = process.env.NEXT_PUBLIC_IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs';

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
export async function uploadToIPFS(
  data: Buffer | string,
  contentType?: string
): Promise<string> {
  try {
    const formData = new FormData();
    const blob = typeof data === 'string' ? new Blob([data], { type: contentType || 'text/plain' }) : new Blob([data], { type: contentType || 'application/octet-stream' });
    formData.append('file', blob);

    const response = await fetch(`${IPFS_API_URL}/api/v0/add`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`IPFS upload failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    return result.Hash; // CID
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
  return uploadToIPFS(jsonString, 'application/json');
}

/**
 * Upload image file to IPFS
 */
export async function uploadImage(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = file.type || 'image/png';
  return uploadToIPFS(buffer, contentType);
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


