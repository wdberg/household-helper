# Household Helper

A gluten-free-friendly weekly meal planner, family calendar, chore list and shopping list that installs as an app on iPhone and Android.

Open https://wdberg.github.io/household-helper/ on your phone:

- **iPhone:** Safari → Share → Add to Home Screen
- **Android:** Chrome → Install app

## What's in it

- **This week:** dinners, breakfasts and lunches for each day, with full recipes, and who's cooking.
- **Calendar:** week and month views showing who cooks each night, the chores due each day, and events. Each person has their own shopping list for the week, and ticking chores earns stars.
- **Pantry:** what's in the fridge, freezer and pantry with use-by dates. Items close to their date are flagged on This week and the calendar, with recipe ideas to use them up, and anything running out can go straight onto a shopping list.
- **Chores:** an editable chore list (daily, weekly, fortnightly, monthly or once), assigned to one person, anyone, or taking turns.
- **Family & sign in:** family members, the usual cook for each night, and the family account.
- Recipes, costs and online shopping, specials watchlist, household items.

## Family accounts

Each family creates one account (email and password) on the Family & sign in tab, and everyone in the family signs in with it on their own phone. Everything syncs between their phones, and each family's data is private to that account. The app still works offline and syncs when it's back online.

Data is stored in the `household-helper` Supabase project, in a single `docs` table protected by row-level security (each account can only read and write its own rows).
