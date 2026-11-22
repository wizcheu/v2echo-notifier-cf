-- Keep existing deadlines intact. Count consecutive unclassified 403 responses
-- independently for the PAT API and Cookie homepage, including manual pairing.
ALTER TABLE control ADD COLUMN api_forbidden_failures INTEGER NOT NULL DEFAULT 0 CHECK(api_forbidden_failures BETWEEN 0 AND 4);
ALTER TABLE control ADD COLUMN web_forbidden_failures INTEGER NOT NULL DEFAULT 0 CHECK(web_forbidden_failures BETWEEN 0 AND 4);
