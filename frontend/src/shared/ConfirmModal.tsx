import { Modal } from './Modal';

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  confirmDanger?: boolean;
}

export function ConfirmModal({ open, onClose, onConfirm, title, message, detail, confirmLabel = 'Delete', confirmDanger = true }: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: '15px', lineHeight: 1.5 }}>{message}</p>
      {detail && <p style={{ margin: '0 0 16px', color: 'var(--text-tertiary)', fontSize: '14px', lineHeight: 1.5 }}>{detail}</p>}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className={`btn ${confirmDanger ? 'btn-danger-solid' : 'btn-primary'}`}
          onClick={() => { onConfirm(); onClose(); }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
