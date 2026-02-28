import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Yes',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p style={{ marginBottom: 20, lineHeight: 1.5 }}>{message}</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel}>{cancelLabel}</button>
        <button className="btn btn-primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
