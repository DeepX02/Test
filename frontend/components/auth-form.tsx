'use client';

import { useState } from 'react';
import { useSignInEmailPassword, useSignUpEmailPassword } from '@nhost/react';
import { nhost } from '@/lib/nhost';

export default function AuthForm() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('alice@acme.com');
  const [password, setPassword] = useState('WorkflowDemo123!');
  const [error, setError] = useState<string | null>(null);

  const { signInEmailPassword, isLoading: signingIn } = useSignInEmailPassword();
  const { signUpEmailPassword, isLoading: signingUp } = useSignUpEmailPassword();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'signin') {
      const { error: err } = await signInEmailPassword(email, password);
      if (err) setError(err.message);
    } else {
      const { error: err } = await signUpEmailPassword(email, password, {
        displayName: email.split('@')[0],
      });
      if (err) {
        setError(err.message);
      } else {
        setMode('signin');
        setError('Account created — please sign in.');
      }
    }
  };

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="card">
        <h1>Agent Workflow Builder</h1>
        <p className="muted" style={{ marginTop: -6 }}>
          Mini n8n for chaining AI agent steps. Multi-tenant orgs, role-based
          permissions, approval gates, live run streaming.
        </p>

        <form onSubmit={submit}>
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <div className="error-box">{error}</div>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" type="submit" disabled={signingIn || signingUp}>
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            >
              {mode === 'signin' ? 'Create an account instead' : 'Sign in instead'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Demo accounts</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>
          All use the password <strong>WorkflowDemo123!</strong>
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {[
              ['alice@acme.com', 'Acme Corp', 'owner'],
              ['bob@acme.com', 'Acme Corp', 'editor'],
              ['carol@acme.com', 'Acme Corp', 'viewer'],
              ['dave@globex.com', 'Globex Inc', 'owner'],
              ['erin@globex.com', 'Globex Inc', 'editor'],
              ['frank@globex.com', 'Globex Inc', 'viewer'],
            ].map(([mail, org, role]) => (
              <tr key={mail}>
                <td style={{ padding: '6px 0' }}>{mail}</td>
                <td style={{ padding: '6px 0' }} className="muted">{org}</td>
                <td style={{ padding: '6px 0' }}>
                  <span className={`badge ${role}`}>{role}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
