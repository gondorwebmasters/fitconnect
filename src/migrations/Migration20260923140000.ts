import { Migration } from '@mikro-orm/migrations';

/**
 * Restricted Schedule sobre la **plantilla semanal** (issue #12) — migración
 * aditiva.
 *
 * - schedule_programmed_allowed_plans: pivote N:M entre `schedule_programmed`
 *   y `plan`. Sin filas ⇒ plantilla sin restricción, que es el estado de todas
 *   las plantillas existentes: la migración no cambia ningún comportamiento
 *   observable.
 * - Tenancy: misma regla y mismo trigger que el pivote del schedule — una
 *   plantilla solo puede referenciar planes de **su propia** empresa.
 *
 * Ver ADR 0005 y CONTEXT.md → Restricted Schedule.
 */
export class Migration20260923140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "schedule_programmed_allowed_plans" ("schedule_programmed_id" uuid not null, "plan_id" uuid not null, constraint "schedule_programmed_allowed_plans_pkey" primary key ("schedule_programmed_id", "plan_id"));`
    );
    this.addSql(
      `alter table "schedule_programmed_allowed_plans" add constraint "schedule_programmed_allowed_plans_sp_id_foreign" foreign key ("schedule_programmed_id") references "schedule_programmed" ("id") on update cascade on delete cascade;`
    );
    this.addSql(
      `alter table "schedule_programmed_allowed_plans" add constraint "schedule_programmed_allowed_plans_plan_id_foreign" foreign key ("plan_id") references "plan" ("id") on update cascade on delete cascade;`
    );
    this.addSql(
      `create index "schedule_programmed_allowed_plans_plan_id_index" on "schedule_programmed_allowed_plans" ("plan_id");`
    );

    this.addSql(`
      create or replace function "schedule_programmed_allowed_plans_same_company"() returns trigger as $$
      begin
        if not exists (
          select 1
          from "schedule_programmed" sp
          join "plan" p on p."company_id" = sp."company_id"
          where sp."id" = new."schedule_programmed_id" and p."id" = new."plan_id"
        ) then
          raise exception 'plan % does not belong to the company of schedule programmed %', new."plan_id", new."schedule_programmed_id";
        end if;
        return new;
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger "schedule_programmed_allowed_plans_same_company_trigger"
      before insert or update on "schedule_programmed_allowed_plans"
      for each row execute function "schedule_programmed_allowed_plans_same_company"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop trigger if exists "schedule_programmed_allowed_plans_same_company_trigger" on "schedule_programmed_allowed_plans";`
    );
    this.addSql(
      `drop function if exists "schedule_programmed_allowed_plans_same_company"();`
    );
    this.addSql(`drop table if exists "schedule_programmed_allowed_plans";`);
  }
}
