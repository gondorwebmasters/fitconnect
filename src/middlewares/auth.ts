import { EntityManager } from '@mikro-orm/core';
import { NextFunction, Request, Response } from 'express';
import jwt, { TokenExpiredError } from 'jsonwebtoken';

import { SubscriptionAccessState } from '../entities/Subscription';
import { User } from '../entities/User';
import { PermissionService } from '../services/permission.service';
import { CurrentUser } from '../types/common.type';
import { LoginPermissionsContext } from '../types/permissions';
import { UnauthorizedError } from '../utils/errors.util';

// Extiende el tipo Request de Express para incluir propiedades custom
declare global {
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
      em?: EntityManager;
    }
  }
}

export const authenticateUser = async (
  em: EntityManager,
  authorization?: string,
  companyId?: string
): Promise<CurrentUser | null> => {
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.substring(7);

    try {
      const decodedToken = jwt.verify(
        token,
        process.env.JWT_SECRET as string
      ) as any;
      const currentUser = await em.findOne(User, { id: decodedToken.id }, {
        filters: !!companyId,
        populate: ['companies'],
      } as any);

      if (!currentUser) {
        throw new UnauthorizedError();
      }

      const permissionService = new PermissionService(em);

      let permissions: LoginPermissionsContext = {
        hasActiveSubscription: false,
        subscriptions: [],
        subscriptionState: SubscriptionAccessState.NONE,
        plan: null,
        permissions: [],
        permissionNames: [],
        subscriptionStatus: null,
        trialEndsAt: null,
        renewsAt: null,
      };
      if (currentUser?.activeCompanyId) {
        permissions = await permissionService.getLoginPermissionsContext(
          currentUser,
          currentUser.activeCompanyId
        );
      }

      const currentUserWithPermissions = {
        ...currentUser,
        ...permissions,
        contextRole: currentUser.contextRole || 'standard',
      };

      return currentUserWithPermissions as CurrentUser;
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new UnauthorizedError();
      } else {
        throw error;
      }
    }
  }
  throw new UnauthorizedError('No token provided');
};

/**
 * Middleware Express que verifica el JWT de la cabecera Authorization.
 * Usado en rutas REST que requieren autenticación (ej: Stripe Connect OAuth).
 * Adjunta el usuario autenticado a req.currentUser.
 */
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authorization = req.headers.authorization;
    const companyId = req.headers['x-company-id'] as string | undefined;
    const em = req.em;

    if (!em) {
      res
        .status(500)
        .json({ success: false, message: 'No EntityManager in request' });
      return;
    }

    const currentUser = await authenticateUser(em, authorization, companyId);
    req.currentUser = currentUser ?? undefined;
    next();
  } catch (error: any) {
    res
      .status(401)
      .json({ success: false, message: error?.message ?? 'Unauthorized' });
  }
};
