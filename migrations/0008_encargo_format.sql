-- Formato del encargo y destino por red.
-- Las filas anteriores quedan con NULL: se leen como formato anterior.

ALTER TABLE encargos ADD COLUMN format TEXT;
ALTER TABLE encargos ADD COLUMN targets_json TEXT;
