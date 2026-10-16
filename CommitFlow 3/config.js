export const STORAGE_KEY = 'commitflow.config.v1';
export const DEFAULT_CONFIG = Object.freeze({ displayName: '', theme: 'system' });

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'displayName') || !Object.hasOwn(value, 'theme') ||
      typeof value.displayName !== 'string' || value.displayName.length > 60 ||
      !['system', 'light', 'dark'].includes(value.theme)) {
    throw new Error('Use a name of at most 60 characters and a valid theme.');
  }
  return { displayName: value.displayName.trim(), theme: value.theme };
}

export function createConfigStore(storage) {
  return {
    async read() {
      const result = await storage.get(STORAGE_KEY);
      if (result[STORAGE_KEY] === undefined) return { ...DEFAULT_CONFIG };
      // Invalid existing data is surfaced, never silently overwritten.
      return validateConfig(result[STORAGE_KEY]);
    },
    async save(value) {
      const config = validateConfig(value);
      await storage.set({ [STORAGE_KEY]: config });
      return config;
    },
    async reset() {
      await storage.remove(STORAGE_KEY);
      return { ...DEFAULT_CONFIG };
    }
  };
}
