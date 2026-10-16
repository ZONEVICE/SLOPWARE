import * as ollama from './api.js';
import * as openrouter from './openrouter.js';

export const PROVIDER_LABELS = Object.freeze({ ollama: 'Ollama', openrouter: 'OpenRouter' });

/**
 * Route each call to the transport named by config.provider. The queue and
 * the views use this object only, so neither knows which protocol runs, and
 * a conversation can switch provider through its own configuration.
 *
 * The OpenRouter key is read from the credentials store at call time: a key
 * saved after a job was queued is used, and the key never enters a snapshot.
 * To add a provider, write a transport module with the same three functions
 * and add a branch here, a PROVIDERS entry in config.js, and a form option.
 */
export function createProviders({ credentials }) {
  const isOpenRouter = config => config.provider === 'openrouter';
  return {
    listModels(config, options) {
      return isOpenRouter(config) ? openrouter.listModels(config, options) : ollama.listModels(config, options);
    },

    /**
     * Connection check for status lines: lists models and identifies the
     * server (Ollama version) or the account (OpenRouter key and limits).
     * `account` is null when no OpenRouter key is set; `accountError` holds
     * a rejected key's explanation while the public model list still loads.
     */
    async describe(config, { signal, models } = {}) {
      if (!isOpenRouter(config)) {
        const [list, version] = await Promise.all([models || ollama.listModels(config, { signal }), ollama.serverVersion(config, { signal }).catch(() => '')]);
        return { provider: 'ollama', models: list, version, account: null, accountError: '' };
      }
      const key = credentials.openRouterKey;
      const [list, account] = await Promise.all([
        models || openrouter.listModels(config, { signal }),
        key ? openrouter.keyInfo(key, { signal }).catch(error => ({ error })) : null,
      ]);
      return { provider: 'openrouter', models: list, version: '', account: account?.error ? null : account, accountError: account?.error?.message || '' };
    },

    streamChat(config, messages, options = {}) {
      return isOpenRouter(config)
        ? openrouter.streamChat(config, messages, { ...options, apiKey: credentials.openRouterKey })
        : ollama.streamChat(config, messages, options);
    },
  };
}
