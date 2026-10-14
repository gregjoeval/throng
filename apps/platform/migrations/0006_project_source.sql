-- The public git URL a project was imported from, or null for a project that started empty. The
-- import copies once, so this records provenance only: nothing reads the source again.
ALTER TABLE projects ADD COLUMN source TEXT;
