import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppShell, Badge, Button, Field, Notice, PageHeader, Table } from './index';

const nav = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/users/invitations', label: 'Invitations' },
];

function shell(currentPath: string) {
  return render(
    <AppShell
      nav={nav}
      currentPath={currentPath}
      user={{ fullName: 'Amel B.', roleLabel: 'Owner' }}
      onLogoutHref="/logout"
    >
      <p>content</p>
    </AppShell>,
  );
}

describe('AppShell', () => {
  it('lists nav items as links and marks only the longest matching prefix as current', () => {
    shell('/admin/users/invitations/42');
    const links = screen.getAllByRole('link', { name: /Overview|Users|Invitations/ });
    // sidebar + drawer copies are not duplicated: exactly one nav landmark is rendered
    expect(links).toHaveLength(3);
    const current = links.filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Invitations');
  });

  it('matches on path segments, not raw string prefixes', () => {
    shell('/admin/usersettings');
    const current = screen
      .getAllByRole('link', { name: /Overview|Users|Invitations/ })
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Overview');
  });

  it('opens and closes the drawer with the button and Escape, keeping aria-expanded in sync', async () => {
    const user = userEvent.setup();
    shell('/admin');
    const button = screen.getByRole('button', { name: /menu/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAccessibleName('Ouvrir le menu');
    expect(button).toHaveAttribute('aria-controls');
    const nav = document.getElementById(button.getAttribute('aria-controls')!);
    expect(nav).not.toBeNull();
    expect(nav).toHaveAttribute('data-open', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAccessibleName('Fermer le menu');
    expect(nav).toHaveAttribute('data-open', 'true');

    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();

    await user.click(button);
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on backdrop click and when the route changes', async () => {
    const user = userEvent.setup();
    const { rerender } = shell('/admin');
    const button = screen.getByRole('button', { name: /menu/i });
    await user.click(button);
    await user.click(document.querySelector('.dl-backdrop') as HTMLElement);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    rerender(
      <AppShell nav={nav} currentPath="/admin/users" user={{ fullName: 'Amel B.', roleLabel: 'Owner' }} onLogoutHref="/logout">
        <p>content</p>
      </AppShell>,
    );
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the user and a logout link', () => {
    shell('/admin');
    expect(screen.getByText('Amel B.')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Se déconnecter/ })).toHaveAttribute('href', '/logout');
  });
});

describe('Field', () => {
  it('links the error to the control with aria-describedby and sets aria-invalid (element child)', () => {
    render(
      <Field label="Email" error="Invalid email" hint="We never share it">
        <input />
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByText('Invalid email');
    const hint = screen.getByText('We never share it');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toEqual(expect.arrayContaining([error.id, hint.id]));
    expect(error.id).not.toBe('');
  });

  it('does not set aria-invalid or describedby when there is neither error nor hint', () => {
    render(
      <Field label="Name">
        <input />
      </Field>,
    );
    const input = screen.getByLabelText('Name');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('supports a render prop that receives id and aria props', () => {
    render(
      <Field label="Role" error="Required">
        {(p) => (
          <select {...p}>
            <option>a</option>
          </select>
        )}
      </Field>,
    );
    const select = screen.getByLabelText('Role');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select.getAttribute('aria-describedby')).toBe(screen.getByText('Required').id);
  });

  it('gives distinct ids to distinct fields', () => {
    render(
      <>
        <Field label="A"><input /></Field>
        <Field label="B"><input /></Field>
      </>,
    );
    expect(screen.getByLabelText('A').id).not.toBe(screen.getByLabelText('B').id);
  });
});

describe('Button', () => {
  it('is disabled with aria-busy when busy', () => {
    render(<Button busy>Save</Button>);
    const b = screen.getByRole('button', { name: /save/i });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
  });

  it('is enabled and not busy by default, defaults to type=button, and maps variants to classes', () => {
    render(
      <>
        <Button>Go</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Del</Button>
      </>,
    );
    const go = screen.getByRole('button', { name: 'Go' });
    expect(go).toBeEnabled();
    expect(go).not.toHaveAttribute('aria-busy');
    expect(go).toHaveAttribute('type', 'button');
    const classes = ['Go', 'Ghost', 'Del'].map((n) => screen.getByRole('button', { name: n }).className);
    expect(new Set(classes).size).toBe(3);
  });
});

describe('Table', () => {
  type Row = { id: number; name: string; email: string };
  const rows: Row[] = [
    { id: 1, name: 'Amel', email: 'a@x.dz' },
    { id: 2, name: 'Yacine', email: 'y@x.dz' },
  ];
  const columns = [
    { key: 'name', header: 'Name', render: (r: Row) => r.name },
    { key: 'email', header: 'Email', render: (r: Row) => r.email, hideBelow: 'md' as const },
  ];

  it('renders empty when there are no rows', () => {
    render(<Table columns={columns} rows={[]} empty={<p>Nothing here</p>} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('row')).toBeNull();
  });

  it('renders a header per column and a labelled cell per column per row', () => {
    render(<Table columns={columns} rows={rows} empty="none" />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Email']);
    const body = screen.getAllByRole('row').slice(1);
    expect(body).toHaveLength(2);
    const cells = within(body[0]!).getAllByRole('cell');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveAttribute('data-label', 'Name');
    expect(cells[1]).toHaveAttribute('data-label', 'Email');
    expect(cells[1]).toHaveTextContent('a@x.dz');
  });

  it('puts explicit table roles on every part (semantics survive display overrides)', () => {
    render(<Table columns={columns} rows={rows} empty="none" />);
    expect(document.querySelector('table')).toHaveAttribute('role', 'table');
    expect(document.querySelector('thead')).toHaveAttribute('role', 'rowgroup');
    expect(document.querySelector('tbody')).toHaveAttribute('role', 'rowgroup');
    document.querySelectorAll('tr').forEach((tr) => expect(tr).toHaveAttribute('role', 'row'));
    document.querySelectorAll('th').forEach((th) => expect(th).toHaveAttribute('role', 'columnheader'));
    document.querySelectorAll('td').forEach((td) => expect(td).toHaveAttribute('role', 'cell'));
    expect(document.querySelector('thead')).toBeInTheDocument();
  });

  it('hides hideBelow columns with a class rather than removing them', () => {
    render(<Table columns={columns} rows={rows} empty="none" />);
    const header = screen.getByRole('columnheader', { name: 'Email' });
    expect(header.className).toMatch(/dl-hide-md/);
    expect(screen.getByRole('columnheader', { name: 'Name' }).className).not.toMatch(/dl-hide/);
    expect(screen.getAllByText(/@x\.dz/)).toHaveLength(2);
    const cells = Array.from(document.querySelectorAll('td[data-label="Email"]'));
    expect(cells).toHaveLength(2);
    cells.forEach((td) => expect(td.className).toMatch(/dl-hide-md/));
  });
});

describe('Badge', () => {
  it('maps tones to distinct classes', () => {
    const tones = ['neutral', 'pink', 'success', 'warning', 'danger'] as const;
    render(
      <>
        {tones.map((t) => (
          <Badge key={t} tone={t}>
            {t}
          </Badge>
        ))}
      </>,
    );
    const classes = tones.map((t) => screen.getByText(t).className);
    expect(new Set(classes).size).toBe(5);
  });
});

describe('PageHeader', () => {
  it('renders eyebrow, title heading and actions', () => {
    render(<PageHeader eyebrow="Admin" title="Users" actions={<button>Invite</button>} />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
  });
});

describe('Notice', () => {
  it('uses role=alert for error and role=status otherwise', () => {
    render(
      <>
        <Notice tone="error">bad</Notice>
        <Notice tone="info">fyi</Notice>
        <Notice tone="success">ok</Notice>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('bad');
    expect(screen.getAllByRole('status').map((n) => n.textContent)).toEqual(['fyi', 'ok']);
  });
});
