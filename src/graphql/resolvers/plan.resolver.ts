import { Plan } from '../../entities/Plan';
import { PlanService } from '../../services/plan.service';
import { ContextProps } from '../../types/resolvers';
import { handleError } from '../../utils/errors.util';
import { plansPermissions } from '../../utils/permissions';
import { withPermissions } from '../middlewares/permissions';

// ===== FIELD RESOLVERS =====

/**
 * @returns Cuántos horarios y plantillas semanales exigen este plan. Lo
 * consume el backoffice para avisar antes de archivarlo (ADR 0005).
 */
const requiredBySchedules = async (
  plan: Plan,
  _: any,
  context: ContextProps
) => {
  const planService = new PlanService(context.em);

  return await planService.countSchedulesRequiringPlan(plan.id);
};

// ===== QUERY RESOLVERS =====

export const getPlan = async (_: any, args: any, context: ContextProps) => {
  try {
    const planService = new PlanService(context.em);
    return await planService.getPlan(args.planId);
  } catch (error: any) {
    return handleError(error);
  }
};

export const listPlans = async (_: any, args: any, context: ContextProps) => {
  try {
    const planService = new PlanService(context.em);
    const onlyActive = args.onlyActive ?? true;
    const showGlobal = args.showGlobal ?? false;
    return await planService.listPlans(onlyActive, showGlobal);
  } catch (error: any) {
    return handleError(error);
  }
};

export const getPlansByCompany = async (
  _: any,
  args: { companyId: string },
  context: ContextProps
) => {
  try {
    const planService = new PlanService(context.em);
    return await planService.getPlansByCompany(args.companyId);
  } catch (error: any) {
    return handleError(error);
  }
};

// ===== MUTATION RESOLVERS =====

export const createPlan = async (_: any, args: any, context: ContextProps) => {
  try {
    const planService = new PlanService(context.em);
    return await planService.createPlan({
      ...args.plan,
      companyId: context.currentUser.activeCompanyId,
    });
  } catch (error: any) {
    return handleError(error);
  }
};

export const updatePlan = async (_: any, args: any, context: ContextProps) => {
  try {
    const planService = new PlanService(context.em);
    return await planService.updatePlan(args.plan);
  } catch (error: any) {
    return handleError(error);
  }
};

export const removePlan = async (_: any, args: any, context: ContextProps) => {
  try {
    const planService = new PlanService(context.em);
    return await planService.deactivatePlan(args.planId);
  } catch (error: any) {
    return handleError(error);
  }
};

export const archivePlan = async (_: any, args: any, context: ContextProps) => {
  try {
    const planService = new PlanService(context.em);
    return await planService.archivePlan(args.planId);
  } catch (error: any) {
    return handleError(error);
  }
};

// ===== EXPORT RESOLVERS OBJECT =====

export const planResolvers = {
  Plan: {
    requiredBySchedules,
  },
  Query: {
    getPlan: withPermissions(plansPermissions.READ, getPlan),
    listPlans,
    getPlansByCompany: withPermissions(
      plansPermissions.READ,
      getPlansByCompany
    ),
  },
  Mutation: {
    createPlan: withPermissions(plansPermissions.CREATE, createPlan),
    updatePlan: withPermissions(plansPermissions.UPDATE, updatePlan),
    removePlan: withPermissions(plansPermissions.DELETE, removePlan),
    archivePlan: withPermissions(plansPermissions.DELETE, archivePlan),
  },
};
