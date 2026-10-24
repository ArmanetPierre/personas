-- Versions immuables (docs/plateforme.md § 3) : le contenu publié d'une version ne change jamais.
-- Seuls le statut, la qualité (recalcul de formule) et l'aperçu peuvent évoluer.
CREATE FUNCTION "personas_hub"."forbid_version_content_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'module_versions' THEN
    IF NEW.yaml IS DISTINCT FROM OLD.yaml OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.version IS DISTINCT FROM OLD.version OR NEW.module_id IS DISTINCT FROM OLD.module_id THEN
      RAISE EXCEPTION 'module version % is immutable', OLD.id;
    END IF;
  ELSE
    IF NEW.files IS DISTINCT FROM OLD.files OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.version IS DISTINCT FROM OLD.version OR NEW.pack_id IS DISTINCT FROM OLD.pack_id OR NEW.extends IS DISTINCT FROM OLD.extends THEN
      RAISE EXCEPTION 'pack version % is immutable', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "module_versions_immutable" BEFORE UPDATE ON "personas_hub"."module_versions" FOR EACH ROW EXECUTE FUNCTION "personas_hub"."forbid_version_content_update"();
--> statement-breakpoint
CREATE TRIGGER "pack_versions_immutable" BEFORE UPDATE ON "personas_hub"."pack_versions" FOR EACH ROW EXECUTE FUNCTION "personas_hub"."forbid_version_content_update"();
