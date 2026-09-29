import moment from 'moment';

import { Plan, PlanInterval } from '../../entities/Plan';
import { Subscription, SubscriptionStatus } from '../../entities/Subscription';
import { User } from '../../entities/User';
import {
  BAD_REQUEST_ERRORS,
  CONFLICT_ERRORS,
  ConflictError,
} from '../../utils/errors.util';
import { SubscriptionService } from '../subscription.service';

/**
 * Tests del seam SubscriptionService.createSubscription para la decisión 8 del
 * ADR 0006: las reglas de solape —**Suscripción Futura** y **Suscripción
 * Retroactiva**— razonan **por plan**, no por miembro (issue #23).
 *
 * Se escribieron cuando el miembro sostenía una sola suscripción, así que "la
 * suscripción actual" no era ambigua. Con el **Entitlement** plural alcanzan a
 * productos que no tienen nada que ver: programar un bono no puede poner a
 * cancelar la membresía, ni registrar un pack en efectivo puede ser rechazado
 * porque el miembro ya tenga *Premium*.
 *
 * Prior art: subscription.add-not-replace.test.ts — EntityManager y procesador
 * de pago mockeados, aserciones sobre la ServiceResponse y sobre el estado de
 * las entidades, nunca sobre qué rama interna se eligió.
 */
describe('SubscriptionService — overlap rules are scoped per Plan', () => {
  let service: SubscriptionService;
  let mockEm: any;
  let user: User;
  /** Suscripciones del usuario en comp-1, tal y como las vería la base. */
  let companySubs: any[];
  let planById: Record<string, any>;
  /** Plan que resuelve getActivePlanOrFail. */
  let requestedPlan: any;

  /**
   * Los planes se reconstruyen en cada test: todos nacen **gratuitos** porque
   * las dos reglas bajo prueba solo son alcanzables con planes gratuitos
   * (`validateStartDateForPlan` obliga a los de pago a empezar hoy), y un
   * objeto compartido se llevaría cualquier retoque al siguiente test.
   */
  function buildPlans() {
    return {
      PREMIUM: {
        id: 'plan-premium',
        amount: 0,
        interval: PlanInterval.MONTH,
        intervalCount: 1,
        currency: 'eur',
        name: 'Premium',
        trialPeriodDays: 0,
        isActive: true,
        sessionCount: null,
        company: { id: 'comp-1' },
      } as any,
      PACK: {
        id: 'plan-pack',
        amount: 0,
        interval: PlanInterval.MONTH,
        intervalCount: 3,
        currency: 'eur',
        name: 'Bono de 10 sesiones',
        trialPeriodDays: 0,
        isActive: true,
        sessionCount: 10,
        company: { id: 'comp-1' },
      } as any,
    };
  }

  let PREMIUM: any;
  let PACK: any;

  /** Una suscripción vigente hoy al plan dado. */
  function liveSub(overrides: Record<string, any> = {}): any {
    return {
      id: `sub-${overrides.plan?.id ?? 'x'}`,
      user,
      company: 'comp-1',
      plan: PREMIUM,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: moment().subtract(10, 'days').toDate(),
      currentPeriodEnd: moment().add(20, 'days').toDate(),
      cancelAtPeriodEnd: false,
      isActive: true,
      metadata: {},
      ...overrides,
    };
  }

  /** Una Suscripción Futura ya programada al plan dado. */
  function scheduledSub(overrides: Record<string, any> = {}): any {
    return liveSub({
      id: `future-${overrides.plan?.id ?? 'x'}`,
      currentPeriodStart: moment().add(30, 'days').toDate(),
      currentPeriodEnd: moment().add(60, 'days').toDate(),
      ...overrides,
    });
  }

  function buildInput(overrides: Record<string, any> = {}) {
    return {
      userId: 'user-1',
      planId: requestedPlan.id,
      companyId: 'comp-1',
      ...overrides,
    };
  }

  /** El Entitlement tal y como lo lee EntitlementService: vigente hoy. */
  function liveNow(sub: any): boolean {
    const now = moment().toDate();
    return (
      [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING].includes(
        sub.status
      ) &&
      sub.currentPeriodStart <= now &&
      sub.currentPeriodEnd >= now
    );
  }

  /** Los eventos anotados en el historial de una suscripción. */
  function historyEvents(subscription: any): string[] {
    return ((subscription.metadata?.history ?? []) as any[]).map(h => h.event);
  }

  /**
   * Evalúa el `where` de un `findOne(Subscription)` contra `companySubs` con
   * los mismos predicados que la query real: empresa, **plan**, `status $in` y
   * la intersección de intervalos. Sin el predicado de plan el test no podría
   * distinguir "solapa con el mismo plan" de "solapa con otro".
   */
  function matchSubscription(where: any): any {
    return (
      companySubs.find(s => {
        if (where.company && s.company !== where.company) return false;
        if (where.plan && s.plan?.id !== where.plan.id) return false;
        if (where.status?.$in && !where.status.$in.includes(s.status)) {
          return false;
        }
        if (
          where.currentPeriodStart?.$lte !== undefined &&
          !(s.currentPeriodStart <= where.currentPeriodStart.$lte)
        ) {
          return false;
        }
        if (
          where.currentPeriodEnd?.$gte !== undefined &&
          !(s.currentPeriodEnd >= where.currentPeriodEnd.$gte)
        ) {
          return false;
        }
        return true;
      }) ?? null
    );
  }

  beforeEach(() => {
    user = new User({} as any);
    user.id = 'user-1';
    companySubs = [];
    ({ PREMIUM, PACK } = buildPlans());
    planById = { [PREMIUM.id]: PREMIUM, [PACK.id]: PACK };
    requestedPlan = PACK;

    mockEm = {
      findOne: jest.fn((entity: any, where: any) => {
        if (entity === User) return user;
        if (entity === Plan) return planById[where.id] ?? null;
        if (entity === Subscription) return matchSubscription(where);
        return null;
      }),
      // Las dos consultas plurales que existen: el Entitlement vigente
      // (lleva rango de periodo) y las activas/futuras de la empresa.
      find: jest.fn(async (_entity: any, where: any) =>
        where.currentPeriodStart ? companySubs.filter(liveNow) : companySubs
      ),
      create: jest.fn((_entity: any, data: any) => ({ ...data })),
      persist: jest.fn(),
      flush: jest.fn(async () => {}),
      refresh: jest.fn(async () => {}),
    };

    service = new SubscriptionService(mockEm as any, {} as any);
    (service as any).customerService.getOrCreateCustomer = jest
      .fn()
      .mockResolvedValue({ id: 'cust-1' });
    (service as any).getDefaultPaymentMethod = jest
      .fn()
      .mockResolvedValue(null);
    // El cobro tiene sus propios tests; aquí solo importa qué se crea.
    (service as any).attemptCharge = jest.fn(async () => {});
  });

  describe('at most one Future Subscription per member per plan', () => {
    it('schedules a future pack even though another plan already has one scheduled', async () => {
      companySubs = [scheduledSub({ plan: PREMIUM })];
      requestedPlan = PACK;

      const response = await service.createSubscription(
        buildInput({ startDate: moment().add(10, 'days').toDate() })
      );

      expect(response.code).toBe(201);
      expect((response as any).subscription.plan).toBe(PACK);
    });

    it('moves the existing future subscription to the same plan instead of adding a second', async () => {
      const scheduled = scheduledSub({ plan: PACK });
      companySubs = [scheduled];
      requestedPlan = PACK;
      const newStart = moment().add(45, 'days');

      const response = await service.createSubscription(
        buildInput({ startDate: newStart.toDate() })
      );

      expect(response.code).toBe(200);
      expect((response as any).subscription).toBe(scheduled);
      expect(moment(scheduled.currentPeriodStart).isSame(newStart, 'day')).toBe(
        true
      );
      expect(mockEm.persist).not.toHaveBeenCalled();
    });
  });

  describe("a Future Subscription's start follows the same plan's period end", () => {
    it('refuses a start that overlaps the live subscription to the same plan', async () => {
      companySubs = [liveSub({ plan: PACK })];
      requestedPlan = PACK;

      const attempt = service.createSubscription(
        buildInput({ startDate: moment().add(2, 'days').toDate() })
      );

      await expect(attempt).rejects.toThrow(
        CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN
      );
    });

    it("refuses a start landing on the same plan's period end day, which would leave two live that day", async () => {
      const pack = liveSub({ plan: PACK });
      companySubs = [pack];
      requestedPlan = PACK;

      const attempt = service.createSubscription(
        buildInput({ startDate: moment(pack.currentPeriodEnd).toDate() })
      );

      await expect(attempt).rejects.toThrow(
        CONFLICT_ERRORS.USER_ALREADY_ACTIVE_IN_PLAN
      );
    });

    it('allows a start that overlaps a live subscription to a different plan', async () => {
      companySubs = [liveSub({ plan: PREMIUM })];
      requestedPlan = PACK;

      const response = await service.createSubscription(
        buildInput({ startDate: moment().add(2, 'days').toDate() })
      );

      expect(response.code).toBe(201);
      expect((response as any).subscription.plan).toBe(PACK);
    });
  });

  describe('scheduling one product never disturbs another', () => {
    it('sets cancelAtPeriodEnd on the live subscription to the same plan', async () => {
      const pack = liveSub({ plan: PACK });
      companySubs = [pack];
      requestedPlan = PACK;

      await service.createSubscription(
        buildInput({
          startDate: moment(pack.currentPeriodEnd).add(1, 'day').toDate(),
        })
      );

      expect(pack.cancelAtPeriodEnd).toBe(true);
      expect(historyEvents(pack)).toContain('cancel_scheduled');
    });

    it('leaves an unrelated live membership renewing when a future pack is scheduled', async () => {
      const premium = liveSub({ plan: PREMIUM });
      companySubs = [premium];
      requestedPlan = PACK;

      await service.createSubscription(
        buildInput({ startDate: moment().add(10, 'days').toDate() })
      );

      expect(premium.cancelAtPeriodEnd).toBe(false);
      expect(historyEvents(premium)).not.toContain('cancel_scheduled');
    });
  });

  describe('a Backdated Subscription only collides with its own plan', () => {
    it('is allowed when it overlaps a live subscription to a different plan', async () => {
      companySubs = [liveSub({ plan: PREMIUM })];
      requestedPlan = PACK;

      const response = await service.createSubscription(
        buildInput({ startDate: moment().subtract(10, 'days').toDate() })
      );

      expect(response.code).toBe(201);
      expect((response as any).subscription.status).toBe(
        SubscriptionStatus.ACTIVE
      );
    });

    it('is refused when it overlaps a live subscription to the same plan', async () => {
      companySubs = [liveSub({ plan: PACK })];
      requestedPlan = PACK;

      const attempt = service.createSubscription(
        buildInput({ startDate: moment().subtract(10, 'days').toDate() })
      );

      await expect(attempt).rejects.toThrow(
        CONFLICT_ERRORS.BACKDATED_OVERLAPS_EXISTING_ENTITLEMENT
      );
    });

    it('refuses it with a ConflictError, not a generic one', async () => {
      companySubs = [liveSub({ plan: PACK })];
      requestedPlan = PACK;

      const attempt = service.createSubscription(
        buildInput({ startDate: moment().subtract(10, 'days').toDate() })
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    });

    it('is still refused by a PAST_DUE subscription to the same plan', async () => {
      companySubs = [
        liveSub({ plan: PACK, status: SubscriptionStatus.PAST_DUE }),
      ];
      requestedPlan = PACK;

      await expect(
        service.createSubscription(
          buildInput({ startDate: moment().subtract(10, 'days').toDate() })
        )
      ).rejects.toThrow(
        CONFLICT_ERRORS.BACKDATED_OVERLAPS_EXISTING_ENTITLEMENT
      );
    });

    it('is not blocked by a cancelled subscription to the same plan', async () => {
      companySubs = [
        liveSub({ plan: PACK, status: SubscriptionStatus.CANCELED }),
      ];
      requestedPlan = PACK;

      const response = await service.createSubscription(
        buildInput({ startDate: moment().subtract(10, 'days').toDate() })
      );

      expect(response.code).toBe(201);
    });

    it('still refuses a backdate whose whole period has already elapsed', async () => {
      requestedPlan = PACK;
      // El bono dura 3 meses: se retrocede más que eso.
      const longGone = moment().subtract(120, 'days').toDate();

      await expect(
        service.createSubscription(buildInput({ startDate: longGone }))
      ).rejects.toThrow(BAD_REQUEST_ERRORS.BACKDATED_PERIOD_ALREADY_ELAPSED);
    });

    it('still refuses backdating a paid plan', async () => {
      PACK.amount = 9000;
      requestedPlan = PACK;

      await expect(
        service.createSubscription(
          buildInput({ startDate: moment().subtract(3, 'days').toDate() })
        )
      ).rejects.toThrow(BAD_REQUEST_ERRORS.PAID_PLAN_MUST_START_TODAY);
    });
  });
});
