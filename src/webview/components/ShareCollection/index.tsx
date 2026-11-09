import React, { useMemo, useState } from 'react';
import Modal from 'components/Modal';
import { IconUpload, IconLoader2, IconAlertTriangle } from '@tabler/icons';
import StyledWrapper from './StyledWrapper';
import Bruno from 'components/Bruno';
import { useSelector } from 'react-redux';
import { findCollectionByUid, areItemsLoading } from 'utils/collections/index';
import { ipcRenderer } from 'utils/ipc';
import toast from 'react-hot-toast';
import {
  loadFullCollection,
  buildBrunoExport,
  buildPostmanExport,
  getPostmanUnsupportedTypes,
  getExportFileName
} from 'utils/exporters/collection-export';

interface ShareCollectionProps {
  onClose: () => void;
  collectionUid: string;
}

const ShareCollection: React.FC<ShareCollectionProps> = ({ onClose, collectionUid }) => {
  const collection = useSelector((state: any) => findCollectionByUid(state.collections.collections, collectionUid));
  const isCollectionLoading = areItemsLoading(collection);
  const [isExporting, setIsExporting] = useState(false);

  const hasNonExportableRequestTypes = useMemo(() => {
    const types = getPostmanUnsupportedTypes(collection);
    return { has: types.length > 0, types };
  }, [collection]);

  const runExport = async (build: () => Promise<{ data: any; warnings?: string[] }>, suffix: string, successMessage: string) => {
    if (isCollectionLoading || isExporting) return;

    setIsExporting(true);
    try {
      const { data, warnings = [] } = await build();
      const content = JSON.stringify(data, null, 2);

      const result = await ipcRenderer.invoke('sidebar:save-file', {
        defaultFileName: getExportFileName(collection.name, suffix),
        content,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      });

      if (result) {
        toast.success(successMessage);
        if (warnings.length) {
          toast(warnings.join('\n'), { icon: '⚠️', duration: 10000 });
        }
        onClose();
      }
    } catch (error) {
      console.error('Error exporting collection:', error);
      toast.error(`Failed to export collection: ${(error as Error)?.message || error}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportBrunoCollection = () =>
    runExport(
      async () => ({ data: buildBrunoExport(await loadFullCollection(collection, ipcRenderer.invoke)) }),
      '',
      'Collection exported successfully'
    );

  const handleExportPostmanCollection = () =>
    runExport(
      async () => {
        const full = await loadFullCollection(collection, ipcRenderer.invoke);
        const { collection: data, warnings } = await buildPostmanExport(full, ipcRenderer.invoke);
        return { data, warnings };
      },
      '_postman',
      'Collection exported in Postman format'
    );

  return (
    <Modal
      size="md"
      title="Export Collection"
      confirmText="Close"
      handleConfirm={onClose}
      handleCancel={onClose}
      hideCancel
    >
      <StyledWrapper className="flex flex-col h-full w-full">
        <div className="space-y-2">
          <div
            className={`share-button ${isCollectionLoading ? 'disabled' : ''}`}
            onClick={isCollectionLoading || isExporting ? undefined : handleExportBrunoCollection}
          >
            <div className="mr-3 p-1 rounded-full">
              {isCollectionLoading ? <IconLoader2 size={28} className="animate-spin" /> : <Bruno width={28} />}
            </div>
            <div className="flex-1">
              <div className="font-medium">Bruno Collection</div>
              <div className="text-xs opacity-70">
                {isCollectionLoading ? 'Loading collection...' : 'Export in Bruno JSON format'}
              </div>
            </div>
          </div>

          <div
            className={`share-button ${isCollectionLoading ? 'disabled' : ''}`}
            onClick={isCollectionLoading || isExporting ? undefined : handleExportPostmanCollection}
          >
            <div className="mr-3 p-1 rounded-full">
              {isCollectionLoading ? (
                <IconLoader2 size={28} className="animate-spin" />
              ) : (
                <IconUpload size={28} strokeWidth={1} />
              )}
            </div>
            <div className="flex-1">
              <div className="font-medium">Postman Collection</div>
              <div className="text-xs opacity-70">
                {isCollectionLoading ? 'Loading collection...' : 'Export in Postman-compatible format'}
              </div>
            </div>
            {hasNonExportableRequestTypes.has && (
              <div className="flex items-center text-xs note-warning px-2 py-1 rounded">
                <IconAlertTriangle size={14} className="mr-1" />
                {hasNonExportableRequestTypes.types.join(', ')} requests will be skipped
              </div>
            )}
          </div>
        </div>
      </StyledWrapper>
    </Modal>
  );
};

export default ShareCollection;
