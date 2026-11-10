import { ROLES } from '@darling/shared';
import { PortalFrame } from '@/components/portal/PortalFrame';

export default function Layout({ children }: LayoutProps<'/compte'>) {
  return (
    <PortalFrame roles={[...ROLES]} allowDuring2faEnrollment>
      {children}
    </PortalFrame>
  );
}
