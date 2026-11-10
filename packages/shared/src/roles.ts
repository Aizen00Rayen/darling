export const ROLES = ['super_manager', 'sub_manager', 'affiliate'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'suspended', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_manager: 'Super Manager',
  sub_manager: 'Sous-manager',
  affiliate: 'Influenceuse',
};

const HOME_PATHS = {
  super_manager: '/admin',
  sub_manager: '/manager',
  affiliate: '/affiliate',
} as const satisfies Record<Role, string>;

export function homePathFor(role: Role): '/admin' | '/manager' | '/affiliate' {
  return HOME_PATHS[role];
}
