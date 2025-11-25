import { Buffer } from 'buffer';
import type { NextApiRequest, NextApiResponse } from 'next';

const IPFS_API_URL =
  process.env.IPFS_API_URL ??
  process.env.NEXT_PUBLIC_IPFS_API_URL ??
  'http://127.0.0.1:5001';

interface IpfsUploadPayload {
  data?: string;
  contentType?: string;
  filename?: string;
}

type IpfsSuccessResponse = {
  Name: string;
  Hash: string;
  Size: string;
};

type IpfsErrorResponse = {
  error: string;
  details?: string;
  statusCode?: number;
};

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

async function forwardToIpfs(payload: Required<IpfsUploadPayload>): Promise<IpfsSuccessResponse> {
  const buffer = Buffer.from(payload.data, 'base64');
  const formData = new FormData();
  const blob = new Blob([buffer], { type: payload.contentType });
  formData.append('file', blob, payload.filename);

  const response = await fetch(`${IPFS_API_URL}/api/v0/add`, {
    method: 'POST',
    body: formData,
  });

  const text = await response.text();
  if (!response.ok) {
    throw {
      statusCode: response.status,
      error: 'ipfs_upstream_error',
      details: text,
    } satisfies IpfsErrorResponse;
  }

  try {
    return JSON.parse(text) as IpfsSuccessResponse;
  } catch {
    throw {
      statusCode: 500,
      error: 'ipfs_response_invalid',
      details: text,
    } satisfies IpfsErrorResponse;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = req.body as IpfsUploadPayload;
  if (!body?.data) {
    res.status(400).json({ error: 'missing_data' });
    return;
  }

  try {
    const result = await forwardToIpfs({
      data: body.data,
      contentType: body.contentType ?? 'application/octet-stream',
      filename: body.filename ?? 'upload.bin',
    });
    res.status(200).json(result);
  } catch (error) {
    const err = error as IpfsErrorResponse | Error;
    if ('error' in err) {
      res.status(err.statusCode ?? 502).json(err);
    } else {
      res.status(502).json({
        error: 'ipfs_proxy_failed',
        details: err.message ?? String(err),
      });
    }
  }
}

