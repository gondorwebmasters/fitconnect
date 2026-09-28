import { Permission } from '../entities/Permission';
import {
  SubscriptionAccessState,
  SubscriptionStatus,
} from '../entities/Subscription';

/**
 * Una suscripción vigente tal y como la ve el payload de auth — issue #20,
 * ADR 0006.
 *
 * @remarks Los créditos viven **aquí**, en cada suscripción, y no sueltos en el
 * payload: un `remainingCredits` global no significa nada cuando el miembro
 * sostiene dos Session Packs.
 */
export interface AuthSubscriptionSummary {
  id: string;
  planId: string | null;
  planName: string | null;
  status: SubscriptionStatus;
  /** Fin del periodo pagado; `trialEnd` si no hay periodo. */
  endDate: Date | null;
  cancelAtPeriodEnd: boolean | null;
  /** `creditsTotal − creditsUsed`. null ⇒ ilimitada. */
  remainingCredits: number | null;
  /** Snapshot de créditos del Session Pack. null ⇒ ilimitada. */
  creditsTotal: number | null;
}

export interface LoginPermissionsContext {
  hasActiveSubscription: boolean;
  /**
   * El **Entitlement** del miembro, una entrada por suscripción vigente. Es la
   * verdad del payload: los campos singulares de abajo son una vista degradada
   * y deprecada de este conjunto (issue #20).
   */
  subscriptions: AuthSubscriptionSummary[];
  /** Estado de acceso derivado que alimenta el banner del front. */
  subscriptionState: SubscriptionAccessState;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  plan: {
    id: string;
    name: string;
    amount: number;
    currency: string;
    interval: string;
  } | null;
  permissions: Permission[];
  permissionNames: string[];
  /**
   * @deprecated Vista singular del Entitlement — usar {@link
   * LoginPermissionsContext.subscriptions}. Resuelve de forma determinista y
   * estable: gana la vigente ilimitada y, en empate o si ninguna lo es, la de
   * periodo más lejano (`selectReportedSubscription`).
   */
  subscriptionStatus: SubscriptionStatus | null;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  subscriptionId?: string;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  trialEndsAt?: Date | null;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  renewsAt?: Date | null;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  isInTrial?: boolean;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  startDate?: Date | null;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  endDate?: Date | null;
  /** @deprecated Ver {@link LoginPermissionsContext.subscriptionStatus}. */
  cancelAtPeriodEnd?: boolean | null;
  /**
   * Session Credits restantes de la suscripción vigente.
   * null ⇒ ilimitado (plan temporal) o sin suscripción.
   *
   * @deprecated Sin sentido global con varios Session Packs: leer los créditos
   * de cada entrada de {@link LoginPermissionsContext.subscriptions}.
   */
  remainingCredits?: number | null;
  /**
   * Snapshot de créditos del Session Pack (N en "te quedan X de N").
   * null ⇒ ilimitado o sin suscripción.
   *
   * @deprecated Ver {@link LoginPermissionsContext.remainingCredits}.
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
