-- A token's optional name is an alias: the user acting under another name, not a separate agent.
ALTER TABLE tokens RENAME COLUMN agent TO alias;
