import { Link, useLocation, useNavigate } from 'react-router-dom';

export function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="not-found-page">
      <div className="not-found-card">
        <div className="not-found-eyebrow">Page not found</div>
        <h1 className="not-found-title">That one's not here.</h1>
        <p className="not-found-body">
          The link <code className="not-found-path">{location.pathname}</code> doesn't match anything I know about.
          Might be a stale bookmark, or a URL that moved.
        </p>
        <div className="not-found-actions">
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            Take me home
          </button>
          <button className="btn btn-ghost" onClick={() => navigate(-1)}>
            Go back
          </button>
        </div>
        <p className="not-found-footer">
          Still stuck? Open <Link to="/">Home</Link> and grab me from the corner — I can help you find what you're after.
        </p>
      </div>
    </div>
  );
}
