export type OpenAIEmbeddingSize = 'small' | 'large';

export const VECTORAMP_EMBEDDING_4B = 'VectorAmp-Embedding-4B';
export const OPENAI_TEXT_EMBEDDING_3_SMALL = 'text-embedding-3-small';
export const OPENAI_TEXT_EMBEDDING_3_LARGE = 'text-embedding-3-large';

export const embeddingDimensions: Record<string, number> = {
  [VECTORAMP_EMBEDDING_4B]: 2560,
  [OPENAI_TEXT_EMBEDDING_3_SMALL]: 1536,
  [OPENAI_TEXT_EMBEDDING_3_LARGE]: 3072
};

export function openai(size: OpenAIEmbeddingSize = 'small') {
  return {
    provider: 'openai',
    model: size === 'large' ? OPENAI_TEXT_EMBEDDING_3_LARGE : OPENAI_TEXT_EMBEDDING_3_SMALL,
    secret_ref: 'emb:openai:api_key'
  };
}
