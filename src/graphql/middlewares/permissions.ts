import { CurrentUser } from '../../types/common.type';
import { ForbiddenError } from '../../utils/errors.util';

/**
 * Whether the user holds every required permission, either directly, through
 * the module's `manage` permission, or through the `*:*` wildcard.
 */
export const hasPermissions = (
  currentUser: CurrentUser | null | undefined,
  requiredPermissions: string[]
): boolean => {
  const userPermissions = currentUser?.permissionNames || [];

  // All permissions wildcard
  if (userPermissions.includes('*:*')) return true;

  return requiredPermissions.every(p => {
    if (userPermissions.includes(p)) return true;

    const [module] = p.split(':');
    return userPermissions.includes(`${module}:manage`);
  });
};

/**
 * Require authentication decorator
 */
export const withPermissions = (
  requiredPermissions: string[],
  resolver: Function
) => {
  return async (parent: any, args: any, context: any, info: any) => {
    if (!hasPermissions(context.currentUser, requiredPermissions)) {
      throw new ForbiddenError();
    }

    return resolver(parent, args, context, info);
  };
};
