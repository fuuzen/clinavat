import { isIP } from 'node:net';
import { HttpError } from '../models.js';
import type { GatewayClient } from './client.js';

export interface NodeLocation {
  node: string;
  ip: string;
  country: string;
  region: string;
  city: string;
  timezone: string;
}

/** A fresh probe follows the requested node, including any edits to its credentials or server. */
export async function nodeLocation(client: GatewayClient, tag: string): Promise<NodeLocation> {
  let result: NodeLocation;
  try { result = await client.call<NodeLocation>('nodes.location', { tag }, 55_000); }
  catch (error) {
    if (error instanceof Error && error.message.includes('不支持的操作')) {
      throw new HttpError(409, '网关控制器尚不支持出口位置查询，请更新 gwctl.py、gateway-chain.py 和 gateway-location.py；也可手动选择时区');
    }
    throw error;
  }
  if (!result || result.node !== tag || typeof result.ip !== 'string' || !isIP(result.ip) || typeof result.timezone !== 'string') {
    throw new HttpError(502, '网关返回的出口位置信息不完整，请手动选择时区');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: result.timezone }); }
  catch { throw new HttpError(502, '出口位置服务未返回可用时区，请手动选择时区'); }
  const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 160) : '';
  return { node: tag, ip: result.ip, country: label(result.country), region: label(result.region),
    city: label(result.city), timezone: result.timezone };
}
