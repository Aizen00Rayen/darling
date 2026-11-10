// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({ api: vi.fn() }));

import { ForgotForm } from './ForgotForm';
import { LoginForm } from './LoginForm';
import { SetPasswordForm } from './SetPasswordForm';

afterEach(cleanup);

const forms = {
  LoginForm: () => <LoginForm next={null} notice={null} />,
  ForgotForm: () => <ForgotForm />,
  SetPasswordForm: () => <SetPasswordForm mode="invite" token={"x".repeat(43)} title="Bienvenue" />,
};

describe.each(Object.entries(forms))('%s', (_name, ui) => {
  it('is a POST form with noValidate, so a pre-hydration submit never puts values in the URL', () => {
    const { container } = render(ui());
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form?.noValidate).toBe(true);
  });

  it('has an enabled submit button once mounted', () => {
    const { container } = render(ui());
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(false);
  });

  it('never has a password input outside a POST form', () => {
    const { container } = render(ui());
    for (const input of container.querySelectorAll('input[type="password"]')) {
      expect(input.closest('form')?.getAttribute('method')?.toLowerCase()).toBe('post');
    }
  });
});

it('renders something for each form', () => {
  render(<ForgotForm />);
  expect(screen.getByRole('button')).toBeTruthy();
});
