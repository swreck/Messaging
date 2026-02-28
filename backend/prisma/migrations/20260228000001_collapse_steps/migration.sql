-- Collapse 8 steps to 5 steps
-- Old: 1=Prep, 2=AllAboutYou, 3=PickAudience, 4=AllAboutAudience, 5=DrawLines, 6=ConvertLines, 7=ThreeTierTable, 8=MagicHour
-- New: 1=Confirm, 2=YourOffering, 3=YourAudience, 4=Building, 5=YourThreeTier

-- Remap draft currentStep values
UPDATE "ThreeTierDraft" SET "currentStep" = CASE
  WHEN "currentStep" = 1 THEN 1
  WHEN "currentStep" = 2 THEN 2
  WHEN "currentStep" = 3 THEN 2  -- PickAudience merged into step 1, but keep at 2 for safety
  WHEN "currentStep" = 4 THEN 3
  WHEN "currentStep" IN (5, 6) THEN 4
  WHEN "currentStep" IN (7, 8) THEN 5
  ELSE "currentStep"
END;

-- Remap conversation message step numbers
-- Old step 4 (audience interview) -> new step 3
UPDATE "ConversationMessage" SET "step" = 3 WHERE "step" = 4;
-- Old step 2 stays as step 2 (offering interview)
