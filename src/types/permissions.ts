import { Permission } from '../entities/Permission';
import {
  SubscriptionAccessState,
  SubscriptionStatus,
} from '../entities/Subscription';

export interface LoginPermissionsContext {
  hasActiveSubscription: boolean;
  /** Estado de acceso derivado que alimenta el banner del front. */
  subscriptionState: SubscriptionAccessState;
  plan: {
    id: string;
    name: string;
    amount: number;
    currency: string;
    interval: string;
  } | null;
  permissions: Permission[];
  permissionNames: string[];
  subscriptionStatus: SubscriptionStatus | null;
  subscriptionId?: string;
  trialEndsAt?: Date | null;
  renewsAt?: Date | null;
  isInTrial?: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
  cancelAtPeriodEnd?: boolean | null;
  /**
   * Session Credits restantes de la suscripción vigente.
   * null ⇒ ilimitado (plan temporal) o sin suscripción.
   */
  remainingCredits?: number | null;
  /**
   * Snapshot de créditos del Session Pack (N en "te quedan X de N").
   * null ⇒ ilimitado o sin suscripción.
   */
  creditsTotal?: number | null;
}

export interface CompanyPermissionsContext {
  companyId: string;
  companyName: string;
  plan: {
    id: string;
    name: string;
    amount: number;
    currency: string;
  };
  permissions: string[];
  subscriptionStatus: SubscriptionStatus;
  isInTrial: boolean;
  trialEndsAt?: Date | null;
  renewsAt?: Date | null;
}
