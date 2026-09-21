import { useMemo } from 'react';
import { get } from 'lodash';
import { findItemInCollection, findParentItemInCollection } from 'utils/collections/index';
import { buildTimelineEntries } from './Timeline/buildEntries';
import type { AuthSource, TimelineDisplayEntry } from './Timeline/buildEntries';
import type { AppCollection, AppItem } from '@bruno-types';

const getEffectiveAuthSource = (collection: any, item: any): AuthSource | null => {
  const authMode = item.draft ? get(item, 'draft.request.auth.mode') : get(item, 'request.auth.mode');
  if (authMode !== 'inherit') return null;

  const collectionRoot = collection?.draft?.root || collection?.root || {};
  let effectiveSource: AuthSource = {
    type: 'collection',
    uid: collection.uid,
    auth: get(collectionRoot, 'request.auth')
  };

  const path = [];
  let currentItem = findItemInCollection(collection, item?.uid);
  while (currentItem) {
    path.unshift(currentItem);
    currentItem = findParentItemInCollection(collection, currentItem?.uid);
  }

  for (const i of [...path].reverse()) {
    if (i.type === 'folder') {
      const folderAuth = get(i, 'root.request.auth');
      if (folderAuth && folderAuth.mode && folderAuth.mode !== 'none' && folderAuth.mode !== 'inherit') {
        effectiveSource = { type: 'folder', uid: i.uid, auth: folderAuth };
        break;
      }
    }
  }

  return effectiveSource;
};

/**
 * The rows the Timeline tab renders, newest first. Includes OAuth2 token calls recorded against an
 * ancestor when this item inherits its auth, so the calls that produced its credentials are visible;
 * each token call becomes its own row. The tab badge and the empty state must use this too, or the
 * count disagrees with what the panel shows.
 */
export const getTimelineEntries = (collection: AppCollection | undefined, item: AppItem): TimelineDisplayEntry[] => {
  if (!collection?.timeline?.length) {
    return [];
  }

  return buildTimelineEntries(collection.timeline, item.uid, getEffectiveAuthSource(collection, item));
};

export const useTimelineEntries = (collection: AppCollection | undefined, item: AppItem): TimelineDisplayEntry[] =>
  useMemo(() => getTimelineEntries(collection, item), [collection?.timeline, item]);
