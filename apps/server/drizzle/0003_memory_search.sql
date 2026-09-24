CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, content, tokenize='trigram');
--> statement-breakpoint
INSERT INTO memories_fts(memory_id, content) SELECT id, content FROM memories;
--> statement-breakpoint
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(memory_id, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts(memory_id, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;
