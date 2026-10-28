import { FlutterwaveAdapter } from './flutterwave/adapter.mjs';
import { PaystackAdapter } from './paystack/adapter.mjs';
import { ValidationError } from '../errors/base-error.mjs';

/**
 * @typedef {import('../types/provider.mjs').ProviderAdapter} ProviderAdapter
 */

/** @type {Record<string, ProviderAdapter>} */
const ADAPTERS = {
  flutterwave: FlutterwaveAdapter,
  paystack: PaystackAdapter,
};

export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(ADAPTERS));

/**
 * Resolves the provider adapter instance by provider identifier.
 * @param {string} providerName - 'flutterwave' | 'paystack'
 * @returns {ProviderAdapter}
 */
export function getAdapter(providerName) {
  const normalized = providerName.toLowerCase().trim();
  const adapter = ADAPTERS[normalized];
  if (!adapter) {
    throw new ValidationError(`Unsupported payment provider: '${providerName}'. Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`);
  }
  return adapter;
}
