import type { ItemType } from '@bruno-types';

export const REQUEST_TYPES: ItemType[] = ['http-request', 'graphql-request', 'grpc-request', 'ws-request'];

export const PREVIEW_SAVE_MIN_INTERVAL_MS = 500;

export const PREVIEW_SAVE_HOTKEY_MESSAGE = { type: 'bruno:preview-hotkey', action: 'save' } as const;
