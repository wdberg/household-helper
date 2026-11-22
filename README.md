# Household Helper

A gluten-free-friendly weekly meal planner, family calendar, chore list and shopping list that installs as an app on iPhone and Android.

Open https://wdberg.github.io/household-helper/ on your phone:

- **iPhone:** Safari → Share → Add to Home Screen
- **Android:** Chrome → Install app

## What's in it

- **This week:** dinners, breakfasts and lunches for each day, with full recipes, and who's cooking.
- **Calendar:** week and month views showing who cooks each night, the chores due each day, and events. Each person has their own shopping list for the week, and ticking chores earns stars.
- **Pantry:** what's in the fridge, freezer and pantry with use-by dates. Items close to their date are flagged on This week and the calendar, with recipe ideas to use them up, and anything running out can go straight onto a shopping list. **What can I cook?** suggests recipes from what's in the pantry, favouring ones that use up food about to go off.
- **Breakfast, lunch & snacks:** ideas and recipes, plus a school-week lunchbox plan for each child (main, fruit or veg, snack, extra), with gluten-free ideas, a nut-free school setting that flags nuts, copy last week, and one tap to add it all to the shopping list.
- **Chores:** an editable chore list (daily, weekly, fortnightly, monthly or once), assigned to one person, anyone, or taking turns.
- **Family & sign in:** family members, the usual cook for each night, and the family account.
- Recipes, costs and online shopping, specials watchlist, household items.

## Family accounts

Everyone gets their own login and belongs to one family:

1. One adult opens **Family & sign in** → **Start a new family**. They become the family's owner.
2. They add everyone in the house under **Everyone in the house**.
3. Under **Invite someone** they choose Adult or Kid, create a 6-character code and tap **Share invite**. A code works for 7 days, for any number of people.
4. Others open the invite link, install the app, and tap **Join my family**. The code is filled in for them.

Roles: the **owner** can do everything, including changing roles and deleting the family; **adults** can change everything and invite people; **kids** can see everything, tick chores and use shopping lists.

Each person can change their password, sign out, or delete their login. The owner can delete the whole family and all its data. The app has step-by-step instructions and a privacy notice on the Family & sign in tab.

Data is stored in the `household-helper` Supabase project (Sydney). Row-level security means only members of a family can read its data, and only owners and adults can change most of it. The database setup is in `supabase/family_members_and_invites.sql`.
